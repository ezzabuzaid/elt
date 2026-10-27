import { createHash } from 'node:crypto';

import { type Got, HTTPError, RequestError, type Response } from 'got';
import { z } from 'zod';

import { AdaptiveRevisit } from './adaptive-revisit.ts';
import {
  type Finding,
  type PageLocation,
  type Priority,
  type Reader,
  priorities,
} from './reader.ts';
import {
  type Change,
  type Outcome,
  type RevisitPolicy,
  hour,
} from './revisit-policy.ts';
import { webUrl } from './web-url.ts';

export class CrawlError extends Error {
  override readonly name = 'CrawlError';
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(
      `Crawl could not read ${url}: ${Error.isError(cause) ? cause.message : String(cause)}`,
      { cause },
    );
    this.url = url;
  }
}

export type CrawledPage = PageLocation & {
  readonly response: Response;
  readonly change: Change;
};
export type CrawlFailure = PageLocation & {
  readonly error: CrawlError;
  /** The URL is a page the crawl would have handed back, not a starting URL or a document. */
  readonly page: boolean;
};
/** A URL the crawl downloaded for its readers without handing it back: a moment to take a snapshot. */
export type CrawlProgress = { readonly progress: string };
/** A known page the crawl did not request, whose last download succeeded: it still exists, unchanged as far as the crawl knows. */
export type CrawlDeferral = { readonly deferred: PageLocation };

// Smooth weighted round-robin weights (nginx's deterministic form of the
// biased front-queue selector, Introduction to Information Retrieval §20.2.3).
const weights = { page: 4, link: 2, backfill: 1 } as const;

const entrySchema = z.object({
  url: z.string(),
  listingUrl: z.string(),
  lastModified: z.string().nullable(),
  hops: z.number().int().nonnegative(),
  start: z.boolean(),
  page: z.boolean(),
  // Some reader reads it as a document.
  document: z.boolean(),
  // Some reader found it as a list of pages.
  list: z.boolean(),
  priority: z.enum(priorities),
  // Its provenance came from a link, so a listing's provenance replaces it.
  linked: z.boolean(),
  tolerate: z.union([z.array(z.number().int()).readonly(), z.literal('any')]),
  notes: z.array(z.unknown()),
});
type Entry = z.infer<typeof entrySchema>;

const knownUrlSchema = z.object({
  // The URL as the crawl last requested it.
  entry: entrySchema,
  // SHA-256 of the body of its last visit; null when that visit failed.
  digest: z.string().nullable(),
  due: z.number().nullable(),
  history: z.unknown(),
});
type KnownUrl = z.infer<typeof knownUrlSchema>;

const mementoSchema = z.object({
  // The unfinished crawl, or null once it is complete.
  crawl: z
    .object({
      at: z.number(),
      pending: z.array(entrySchema),
      known: z.array(z.string()),
      // URLs this crawl handed back as pages: each is handed back once.
      handed: z.array(z.string()),
      states: z.array(z.unknown()),
      // Origins that answered 403 or 429, with when their breaker closes.
      blocked: z.record(z.string(), z.number()),
    })
    .nullable(),
  // Every URL a crawl visited, across crawls, with when it is due again.
  urls: z.record(z.string(), knownUrlSchema),
});
export type CrawlMemento = z.infer<typeof mementoSchema>;

export type CrawlOptions = {
  readonly signal: AbortSignal;
  /** Pages to hand back; other pages are downloaded only when a reader wants them. */
  readonly include?: readonly URLPattern[];
};

export interface Crawl extends AsyncIterable<
  CrawledPage | CrawlFailure | CrawlProgress | CrawlDeferral
> {
  /** The crawl so far as plain data. The entry handed out last stays unfinished until the next is requested. */
  snapshot(): CrawlMemento;
  /** The caller could not use a page it was handed back, so the page is due again as a failed one. */
  fail(url: string): void;
  /** When the next crawl has a known URL due, starting URLs included; null when none ever is. */
  nextDue(): number | null;
}

export class WebCrawler {
  readonly #http: Got;
  readonly #readers: readonly Reader<unknown, unknown>[];
  readonly #revisit: RevisitPolicy<unknown>;

  constructor(
    http: Got,
    readers: readonly Reader<unknown, unknown>[],
    revisit: RevisitPolicy<unknown> = new AdaptiveRevisit(),
  ) {
    if (readers.length === 0)
      throw new TypeError('At least one reader is required');
    this.#http = http;
    this.#readers = readers.slice();
    this.#revisit = revisit;
  }

  /**
   * Continues the memento's unfinished crawl, or starts a new one from the
   * starting URLs and every known URL that is due. A null memento knows no URL.
   */
  crawl(
    starts: readonly string[],
    memento: unknown,
    options: CrawlOptions,
  ): Crawl {
    const { crawl, urls } =
      memento === null
        ? { crawl: null, urls: {} }
        : mementoSchema.parse(memento);
    const known = new Map(
      Object.entries(urls).map(([url, { entry, ...visit }]) => [
        url,
        {
          ...visit,
          entry: this.#restore(entry),
          history: this.#revisit.histories.nullable().parse(visit.history),
        },
      ]),
    );
    const startUrls = starts.map((start) => webUrl(start, start));
    const run = (
      at: number,
      states: unknown[],
      entries: Entry[],
      crawled: readonly string[],
      handed: readonly string[],
      blocked: Record<string, number>,
    ) =>
      new CrawlRun(this.#http, this.#readers, this.#revisit, options, {
        at,
        states,
        entries,
        crawled,
        handed,
        blocked,
        known,
        revisits: [...known.values()].flatMap(({ entry }) =>
          startUrls.includes(entry.url) ? [] : [{ ...entry, start: false }],
        ),
      });
    if (crawl !== null)
      return run(
        crawl.at,
        this.#readers.map((reader, index) =>
          reader.states.parse(crawl.states[index]),
        ),
        crawl.pending.map((entry) => this.#restore(entry)),
        crawl.known,
        crawl.handed,
        crawl.blocked,
      );
    return run(
      Date.now(),
      this.#readers.map((reader) => reader.open()),
      startUrls.map((url) => ({
        url,
        listingUrl: url,
        lastModified: null,
        hops: 0,
        start: true,
        page: false,
        document: true,
        list: false,
        priority: 'listing' as const,
        linked: false,
        tolerate: [],
        notes: this.#readers.map(() => null),
      })),
      [],
      [],
      {},
    );
  }

  #restore(entry: Entry): Entry {
    return {
      ...entry,
      notes: this.#readers.map((reader, index) =>
        reader.notes.nullable().parse(entry.notes[index]),
      ),
    };
  }
}

class CrawlRun implements Crawl {
  readonly #http: Got;
  readonly #readers: readonly Reader<unknown, unknown>[];
  readonly #revisit: RevisitPolicy<unknown>;
  readonly #options: CrawlOptions;
  readonly #at: number;
  readonly #states: unknown[];
  readonly #urls: Map<string, KnownUrl>;
  readonly #lanes: Record<Priority, Map<string, Entry>> = {
    listing: new Map(),
    page: new Map(),
    link: new Map(),
    backfill: new Map(),
  };
  readonly #credit: Record<keyof typeof weights, number> = {
    page: 0,
    link: 0,
    backfill: 0,
  };
  // Every URL pending or downloaded in this crawl; a skipped page leaves so a later finding can still bring it in.
  readonly #known = new Set<string>();
  readonly #handed: Set<string>;
  // URLs this crawl downloads again for a role they add: no reader admits them a second time.
  readonly #again = new Set<string>();
  // A circuit breaker per origin that answered 403 or 429 (Nygard, Release It!):
  // while open, the crawl requests nothing there. One opened in this crawl
  // stays open to its end, as Nutch clears a blocked host's queue for the round.
  readonly #blocked: Map<string, number>;
  // Pending entries of a blocked origin, out of the lanes until a later crawl resumes them.
  readonly #held = new Map<string, Entry>();
  // 403 answers in a row, by origin.
  readonly #forbidden = new Map<string, number>();
  // The page handed back last, added to #handed with its visit, as the entry stays pending.
  #hand: string | null = null;
  #current: Entry | null = null;
  // The last visit's schedule, kept out of the URLs until the next entry is requested, as the entry stays pending.
  #visit: {
    readonly before: KnownUrl | undefined;
    readonly after: KnownUrl;
  } | null = null;
  #complete = false;
  // Known URLs, offered once this crawl's findings run out, so a finding's fresh provenance comes first.
  readonly #revisits: Entry[];

  constructor(
    http: Got,
    readers: readonly Reader<unknown, unknown>[],
    revisit: RevisitPolicy<unknown>,
    options: CrawlOptions,
    {
      at,
      states,
      entries,
      crawled,
      handed,
      blocked,
      known,
      revisits,
    }: {
      readonly at: number;
      readonly states: unknown[];
      readonly entries: readonly Entry[];
      readonly crawled: readonly string[];
      readonly handed: readonly string[];
      readonly blocked: Record<string, number>;
      readonly known: Map<string, KnownUrl>;
      readonly revisits: Entry[];
    },
  ) {
    this.#http = http;
    this.#readers = readers;
    this.#revisit = revisit;
    this.#options = options;
    this.#at = at;
    this.#states = states;
    this.#urls = known;
    this.#revisits = revisits;
    this.#handed = new Set(handed);
    this.#blocked = new Map(Object.entries(blocked));
    // Pending entries were admitted when found; one may be a URL this crawl already downloaded.
    for (const entry of entries) this.#add(entry);
    for (const url of crawled) this.#known.add(url);
  }

  snapshot(): CrawlMemento {
    return structuredClone({
      crawl: this.#complete
        ? null
        : {
            at: this.#at,
            pending: [
              ...(this.#current ? [this.#current] : []),
              ...priorities.flatMap((priority) => [
                ...this.#lanes[priority].values(),
              ]),
              ...this.#held.values(),
            ],
            known: [...this.#known],
            handed: [...this.#handed],
            states: this.#states,
            blocked: Object.fromEntries(this.#blocked),
          },
      urls: Object.fromEntries(this.#urls),
    });
  }

  fail(url: string): void {
    const visit =
      this.#visit?.after.entry.url === url ? this.#visit : undefined;
    const before = visit ? visit.before : this.#urls.get(url);
    const entry = visit?.after.entry ?? before?.entry;
    if (entry === undefined)
      throw new TypeError(`The crawl did not hand back ${url}`);
    const after = this.#schedule(entry, 'failed', null, null, before);
    if (visit) this.#visit = { before, after };
    else this.#urls.set(url, after);
  }

  nextDue(): number | null {
    // A crawl held back by its breakers continues when the first one closes.
    if (!this.#complete && this.#held.size > 0)
      return Math.min(...this.#blocked.values());
    const known = [...this.#urls.values()];
    if (this.#visit) known.push(this.#visit.after);
    let next: number | null = null;
    for (const { due } of known)
      if (due !== null && (next === null || due < next)) next = due;
    return next;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<
    CrawledPage | CrawlFailure | CrawlProgress | CrawlDeferral
  > {
    const { signal } = this.#options;
    signal.throwIfAborted();
    // Breakers close by the clock when the crawl runs, not when it started.
    const now = Date.now();
    for (const [origin, until] of this.#blocked)
      if (until <= now) this.#blocked.delete(origin);
    for (;;) {
      this.#commit();
      const next = this.#next();
      if (!next) break;
      const { entry, included, wanted } = next;
      const before = this.#urls.get(entry.url);
      const page = included && !entry.document;
      let response: Response;
      try {
        response = await this.#http(entry.url, {
          signal,
          responseType: 'buffer',
          throwHttpErrors: false,
          // Lets the caller's Got hooks tell pages it reads from documents readers read.
          context: { page },
        });
      } catch (cause) {
        signal.throwIfAborted();
        const errorResponse =
          cause instanceof RequestError ? cause.response : undefined;
        this.#visited(entry, 'failed', null, null, before);
        yield this.#tolerates(entry, errorResponse?.statusCode)
          ? { progress: entry.url }
          : this.#failure(entry, page, errorResponse?.url ?? entry.url, cause);
        continue;
      }
      signal.throwIfAborted();
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const { statusCode } = response;
      const origin = new URL(response.url).origin;
      const tolerated = this.#tolerates(entry, statusCode);
      // A 403 can close one page, such as a members-only one, so only a run
      // of them, as Nutch's fetcher.max.exceptions.per.queue counts, is a block.
      const forbidden =
        statusCode === 403 && !tolerated
          ? (this.#forbidden.get(origin) ?? 0) + 1
          : 0;
      this.#forbidden.set(origin, forbidden);
      if (!tolerated && (statusCode === 429 || forbidden >= forbiddenRun)) {
        // A block is the host's, not the page's: the URL goes back to the
        // frontier, and the revisit policy does not schedule it.
        const until = blockedUntil(headers.get('retry-after'));
        this.#blocked.set(origin, until);
        // A redirect reached the blocked origin, so requests to the URL's own origin would too.
        this.#blocked.set(new URL(entry.url).origin, until);
        this.#held.set(entry.url, entry);
        this.#current = null;
        yield this.#failure(
          entry,
          page,
          response.url,
          new Error(
            `${origin} answered ${statusCode}, so the crawl requests nothing there until ${new Date(until).toISOString()}`,
            { cause: new HTTPError(response) },
          ),
        );
        continue;
      }
      const failed = !response.ok || statusCode === 304;
      let change: Change = 'unknown';
      if (failed)
        this.#visited(
          entry,
          [404, 410].includes(statusCode) ? 'gone' : 'failed',
          headers,
          null,
          before,
        );
      else {
        const digest = createHash('sha256')
          .update(response.rawBody)
          .digest('hex');
        if (before !== undefined && before.digest !== null)
          change = before.digest === digest ? 'unmodified' : 'modified';
        this.#visited(entry, change, headers, digest, before);
      }
      if (failed && !tolerated) {
        yield this.#failure(entry, page, response.url, new HTTPError(response));
        continue;
      }
      const type =
        headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
        null;
      // A reader can bring this URL's next visit forward, whatever the policy,
      // as for a feed that would roll items off before the visit.
      const revisitWithin = (within: number) => {
        if (this.#visit === null) return;
        const { before, after } = this.#visit;
        const limit = this.#at + within;
        if (after.due === null || limit < after.due)
          this.#visit = { before, after: { ...after, due: limit } };
      };
      // Readers are independent: one that cannot read the response is reported
      // for it, and the others still read it. The page itself did not fail.
      for (const [index, reader] of this.#readers.entries()) {
        try {
          for (const finding of await reader.read(
            {
              response,
              headers,
              type,
              request: entry,
              note: entry.notes[index],
              wanted: wanted[index] === true,
              revisitWithin,
            },
            this.#states[index],
          ))
            this.#enqueue(this.#entry(finding, entry, response.url, index));
        } catch (cause) {
          signal.throwIfAborted();
          yield this.#failure(entry, false, response.url, cause);
        }
      }
      signal.throwIfAborted();
      // A URL downloaded again for a role it adds is a page already handed back.
      if (included && !failed && !this.#handed.has(entry.url)) {
        this.#hand = entry.url;
        yield {
          url: entry.url,
          listingUrl: entry.listingUrl,
          lastModified: entry.lastModified,
          response,
          change,
        };
      } else yield { progress: entry.url };
    }
    // Entries of a blocked origin remain: the crawl is unfinished.
    if (this.#held.size > 0) return;
    for (const [url, { entry, digest }] of this.#urls)
      if (
        entry.page &&
        digest !== null &&
        !this.#known.has(url) &&
        this.#includes(url)
      )
        yield {
          deferred: {
            url,
            listingUrl: entry.listingUrl,
            lastModified: entry.lastModified,
          },
        };
    this.#complete = true;
  }

  #visited(
    entry: Entry,
    outcome: Outcome,
    headers: Headers | null,
    digest: string | null,
    before: KnownUrl | undefined,
  ) {
    this.#visit = {
      before,
      after: this.#schedule(entry, outcome, headers, digest, before),
    };
  }

  #schedule(
    entry: Entry,
    outcome: Outcome,
    headers: Headers | null,
    digest: string | null,
    before: KnownUrl | undefined,
  ): KnownUrl {
    const { due, history } = this.#revisit.schedule(
      { request: entry, outcome, headers, at: this.#at },
      before?.history ?? null,
    );
    return { entry, digest, due, history };
  }

  #commit() {
    if (this.#hand !== null) this.#handed.add(this.#hand);
    this.#hand = null;
    if (this.#visit === null) return;
    this.#urls.set(this.#visit.after.entry.url, this.#visit.after);
    this.#visit = null;
  }

  // The next entry worth a download. One nobody needs is dropped without
  // using its lane's turn, so turns are spent on downloads: a lane full of
  // skipped links cannot hand its share to backfill.
  #next() {
    for (;;) {
      for (let lane = this.#lane(); lane; lane = this.#lane())
        for (const entry of lane.values()) {
          lane.delete(entry.url);
          if (this.#blocked.has(new URL(entry.url).origin)) {
            this.#held.set(entry.url, entry);
            continue;
          }
          const included = entry.page && this.#includes(entry.url);
          // A reader's budget counts admissions, and a second download of a URL is none.
          const wanted = this.#again.delete(entry.url)
            ? this.#readers.map(() => false)
            : this.#readers.map((reader, index) =>
                reader.wants(entry, this.#states[index]),
              );
          if (
            entry.start ||
            entry.document ||
            included ||
            wanted.includes(true)
          ) {
            this.#current = entry;
            return { entry, included, wanted };
          }
          this.#known.delete(entry.url);
        }
      if (this.#revisits.length === 0) break;
      // Nutch's generate step: a known URL that is due returns even when nothing lists it in this crawl.
      for (const entry of this.#revisits.splice(0)) this.#enqueue(entry);
    }
    this.#current = null;
    return undefined;
  }

  // Listings go strictly first: they are bounded, and their provenance must
  // reach pages before the pages download. The other lanes share by weight:
  // each waiting lane gains its weight, the richest goes and pays the total.
  #lane() {
    if (this.#lanes.listing.size > 0) return this.#lanes.listing;
    let total = 0;
    let chosen: keyof typeof weights | undefined;
    for (const lane of ['page', 'link', 'backfill'] as const) {
      if (this.#lanes[lane].size === 0) {
        this.#credit[lane] = 0;
        continue;
      }
      this.#credit[lane] += weights[lane];
      total += weights[lane];
      if (chosen === undefined || this.#credit[lane] > this.#credit[chosen])
        chosen = lane;
    }
    if (chosen === undefined) return undefined;
    this.#credit[chosen] -= total;
    return this.#lanes[chosen];
  }

  #includes(url: string) {
    return (
      this.#options.include === undefined ||
      this.#options.include.some((pattern) => pattern.test(url))
    );
  }

  #tolerates(entry: Entry, status: number | undefined) {
    return (
      entry.tolerate === 'any' ||
      (status !== undefined && entry.tolerate.includes(status))
    );
  }

  #failure(
    entry: Entry,
    page: boolean,
    url: string,
    cause: unknown,
  ): CrawlFailure {
    return {
      url: entry.url,
      listingUrl: entry.listingUrl,
      lastModified: entry.lastModified,
      error: new CrawlError(url, cause),
      page,
    };
  }

  #entry(
    finding: Finding<unknown>,
    parent: Entry,
    listingUrl: string,
    index: number,
  ): Entry {
    const notes: unknown[] = this.#readers.map(() => null);
    notes[index] = finding.note;
    return {
      url: webUrl(finding.url, listingUrl),
      listingUrl,
      lastModified: finding.lastModified,
      hops: parent.hops + (finding.linked ? 1 : 0),
      start: false,
      page: finding.page,
      document: !finding.page,
      list: finding.list,
      priority: finding.priority,
      linked: finding.linked,
      tolerate: finding.tolerate,
      notes,
    };
  }

  // A known URL that is not due stays out of this crawl, whatever finds it;
  // only a starting URL always goes in. Reader admission comes after, so a
  // URL left out spends no reader budget.
  #enqueue(next: Entry) {
    if (this.#pending(next.url) === undefined) {
      if (this.#known.has(next.url)) {
        // This crawl downloaded the URL: it goes again only for a role that
        // download did not have, with every role, so Got's cache revalidates it.
        const visited = (
          this.#visit?.after.entry.url === next.url
            ? this.#visit.after
            : this.#urls.get(next.url)
        )?.entry;
        if (visited === undefined) return;
        const addsRole =
          (next.page && !visited.page) || (next.list && !visited.list);
        if (!addsRole) return;
        const again = { ...visited, priority: next.priority };
        merge(again, next);
        next = again;
        this.#again.add(next.url);
      } else {
        const known = this.#urls.get(next.url);
        if (
          known !== undefined &&
          !next.start &&
          !this.#revisit.due(
            next,
            { ...known, lastModified: known.entry.lastModified },
            this.#at,
          )
        )
          return;
      }
    }
    this.#add(next);
  }

  #add(next: Entry) {
    const held = this.#held.get(next.url);
    if (held) {
      merge(held, next);
      return;
    }
    const pending = this.#pending(next.url);
    if (!pending) {
      this.#known.add(next.url);
      this.#lanes[next.priority].set(next.url, next);
      return;
    }
    const { priority } = pending;
    merge(pending, next);
    if (pending.priority !== priority) {
      this.#lanes[priority].delete(pending.url);
      this.#lanes[pending.priority].set(pending.url, pending);
    }
  }

  #pending(url: string) {
    return (
      this.#held.get(url) ??
      priorities
        .map((priority) => this.#lanes[priority].get(url))
        .find((entry) => entry !== undefined)
    );
  }
}

// 403 answers in a row from one origin that make a block.
const forbiddenRun = 3;

// When a block ends, by its Retry-After in seconds or as an HTTP-date (RFC 9110 §10.2.3); an hour without one.
function blockedUntil(retryAfter: string | null) {
  const value = retryAfter?.trim() ?? '';
  if (/^\d+$/.test(value)) return Date.now() + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? Date.now() + hour : date;
}

// Folds a finding into an entry for the same URL: roles only grow.
function merge(pending: Entry, next: Entry) {
  // A starting URL has no provenance of its own: its first page finding gives it one.
  if (
    (pending.linked && !next.linked) ||
    (pending.start && !pending.page && next.page)
  ) {
    pending.listingUrl = next.listingUrl;
    pending.lastModified = next.lastModified;
    pending.linked = next.linked;
  }
  // A URL that is also a page counts the hops of its page findings; a document's do not lower them.
  if (next.page === pending.page)
    pending.hops = Math.min(pending.hops, next.hops);
  else if (next.page) {
    pending.hops = next.hops;
    pending.page = true;
  }
  pending.start ||= next.start;
  pending.document ||= next.document;
  pending.list ||= next.list;
  // The most urgent finding decides when the URL downloads.
  if (priorities.indexOf(next.priority) < priorities.indexOf(pending.priority))
    pending.priority = next.priority;
  const { tolerate } = next;
  if (pending.tolerate === 'any') pending.tolerate = tolerate;
  else if (tolerate !== 'any')
    pending.tolerate = pending.tolerate.filter((status) =>
      tolerate.includes(status),
    );
  pending.notes = pending.notes.map((note, index) => note ?? next.notes[index]);
}
