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
import type { Change, Outcome, RevisitPolicy } from './revisit-policy.ts';
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
      states: z.array(z.unknown()),
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
    ) =>
      new CrawlRun(this.#http, this.#readers, this.#revisit, options, {
        at,
        states,
        entries,
        crawled,
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
      known,
      revisits,
    }: {
      readonly at: number;
      readonly states: unknown[];
      readonly entries: readonly Entry[];
      readonly crawled: readonly string[];
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
    for (const entry of entries) this.#enqueue(entry);
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
            ],
            known: [...this.#known],
            states: this.#states,
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
      const failed = !response.ok || response.statusCode === 304;
      let change: Change = 'unknown';
      if (failed)
        this.#visited(
          entry,
          [404, 410].includes(response.statusCode) ? 'gone' : 'failed',
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
      if (failed && !this.#tolerates(entry, response.statusCode)) {
        yield this.#failure(entry, page, response.url, new HTTPError(response));
        continue;
      }
      const type =
        headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
        null;
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
      yield included && !failed
        ? {
            url: entry.url,
            listingUrl: entry.listingUrl,
            lastModified: entry.lastModified,
            response,
            change,
          }
        : { progress: entry.url };
    }
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
          const included = entry.page && this.#includes(entry.url);
          const wanted = this.#readers.map((reader, index) =>
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
    const pending = priorities
      .map((priority) => this.#lanes[priority].get(next.url))
      .find((entry) => entry !== undefined);
    if (!pending) {
      if (this.#known.has(next.url)) return;
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
      this.#known.add(next.url);
      this.#lanes[next.priority].set(next.url, next);
      return;
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
    if (
      priorities.indexOf(next.priority) < priorities.indexOf(pending.priority)
    ) {
      this.#lanes[pending.priority].delete(pending.url);
      pending.priority = next.priority;
      this.#lanes[pending.priority].set(pending.url, pending);
    }
    if (pending.linked && !next.linked) {
      pending.listingUrl = next.listingUrl;
      pending.lastModified = next.lastModified;
      pending.linked = false;
    }
    const { tolerate } = next;
    if (pending.tolerate === 'any') pending.tolerate = tolerate;
    else if (tolerate !== 'any')
      pending.tolerate = pending.tolerate.filter((status) =>
        tolerate.includes(status),
      );
    pending.notes = pending.notes.map(
      (note, index) => note ?? next.notes[index],
    );
  }
}
