import { createHash } from 'node:crypto';

import { type Got, HTTPError, RequestError, type Response } from 'got';
import { z } from 'zod';

import { OriginLane } from './origin-lane.ts';
import type { Origins } from './origins.ts';
import {
  type CrawlRequest,
  type Finding,
  type Naming,
  type PageLocation,
  type Priority,
  type Reader,
  type Route,
  isHtml,
  priorities,
  routeHows,
} from './reader.ts';
import {
  type Change,
  type Outcome,
  type RevisitPolicy,
} from './revisit-policy.ts';
import { RobotsRules } from './robots-rules.ts';
import { httpUrl, webUrl } from './web-url.ts';

// The entry being handed out, the page handed back, and the visit's schedule,
// added to #handed and the URLs once the next entry is requested.
type Turn = {
  readonly current: Entry | null;
  readonly hand: string | null;
  readonly visit: {
    readonly before: KnownUrl | undefined;
    readonly after: KnownUrl;
  } | null;
};

const idle: Turn = { current: null, hand: null, visit: null };

export class CrawlError extends Error {
  override readonly name = 'CrawlError';
  readonly url: string;
  /** The URL is a page the crawl would have handed back, not a starting URL or a document such as a sitemap. */
  readonly page: boolean;

  constructor(url: string, cause: unknown, page: boolean) {
    super(
      `Crawl could not read ${url}: ${Error.isError(cause) ? cause.message : String(cause)}`,
      { cause },
    );
    this.url = url;
    this.page = page;
  }
}

/**
 * What one read named: the URL that a response came from and each URL in the
 * crawl's scope that the response names, whether the crawl already knows it
 * or not. A request that was redirected names the URL it was redirected to.
 */
export type ListingRoutes = {
  readonly listingUrl: string;
  /** Every reader read the response, so the routes are all that it names. A reader that threw or skipped the response leaves it incomplete. */
  readonly complete: boolean;
  readonly routes: readonly Route[];
};

export type CrawledPage = PageLocation & {
  readonly response: Response;
  readonly change: Change;
  /** What this read of the page named. */
  readonly routes: readonly ListingRoutes[];
};
export type CrawlFailure = PageLocation & { readonly error: CrawlError };
/** A URL the crawl downloaded for its readers without handing it back: a moment to take a snapshot. */
export type CrawlProgress = {
  readonly progress: string;
  /** What this read of the URL named; none when no reader read it. */
  readonly routes: readonly ListingRoutes[];
};
/** A known page the crawl did not request, whose last download succeeded: it still exists, unchanged as far as the crawl knows. */
export type CrawlDeferral = { readonly deferred: PageLocation };

// Smooth weighted round-robin weights (nginx's deterministic form of the
// biased front-queue selector, Introduction to Information Retrieval §20.2.3).
const weights = { page: 4, link: 2, backfill: 1 } as const;

const entrySchema = z.object({
  url: z.string(),
  listingUrl: z.string(),
  lastModified: z.string().nullable(),
  published: z.string().nullable(),
  // The language copies that the listing declares for this URL.
  localizedVersions: z
    .array(z.object({ language: z.string(), url: z.string() }))
    .readonly(),
  hops: z.number().int().nonnegative(),
  // The starting URL that this request is, or that a redirect of it led here; null for any other URL.
  start: z.string().nullable(),
  page: z.boolean(),
  // Some reader reads it as a document.
  document: z.boolean(),
  // Some reader found it as a list of pages.
  list: z.boolean(),
  // How readers expand it: 'origin' for a starting URL, 'step' for a page that a list hands back on an origin that no starting URL names.
  expand: z.enum(['origin', 'step']).nullable(),
  // A one-step expansion found it, directly or through what it found, such as the sitemaps of its robots.txt: the crawl keeps only its findings that match the expand patterns, and expands none.
  within: z.boolean(),
  priority: z.enum(priorities),
  // Its provenance came from a link, so a listing's provenance replaces it.
  linked: z.boolean(),
  tolerate: z.union([z.array(z.number().int()).readonly(), z.literal('any')]),
  notes: z.array(z.unknown()),
  // The request that a redirect of another request makes, which continues
  // it: its redirects so far, the readers that admitted the first request,
  // whether include selected that request's page, and the Got context of the
  // request that redirected, as Got carries a request's options to each hop.
  // Null for a URL that a reader found.
  redirect: z
    .object({
      hops: z.number().int().positive(),
      wanted: z.array(z.boolean()),
      included: z.boolean(),
      context: z.record(z.string(), z.json()),
    })
    .nullable(),
});
type Entry = z.infer<typeof entrySchema>;

const lastSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fetched'), digest: z.string() }),
  z.object({
    kind: z.literal('redirect'),
    target: z.string(),
    // 301 or 308 (RFC 9110 §15.4.2, §15.4.9).
    permanent: z.boolean(),
  }),
  z.object({ kind: z.literal('failed') }),
]);
type Last = z.infer<typeof lastSchema>;

const knownUrlSchema = z.object({
  // The URL as the crawl last requested it.
  entry: entrySchema,
  // What its last visit got, as Nutch's CrawlDatum keeps a fetched page's
  // signature apart from its redirect statuses: a body with its SHA-256, a
  // redirect with its target, or no answer to keep.
  last: lastSchema,
  due: z.number().nullable(),
  history: z.unknown(),
});
type KnownUrl = z.infer<typeof knownUrlSchema>;

const mementoSchema = z.object({
  // The unfinished crawl, or null once it is complete.
  crawl: z
    .object({
      pending: z.array(entrySchema),
      states: z.array(z.unknown()),
      // Origins of the starting URLs: a list's page on another origin is expanded one step.
      origins: z.array(z.string()),
    })
    .nullable(),
  // Every URL a crawl visited, across crawls, with when it is due again.
  urls: z.record(z.string(), knownUrlSchema),
  // Each starting URL that answered with an HTML or Markdown page, across
  // crawls, with the origin that answered: LinkReader follows links there
  // also in a crawl that does not read the starting page.
  pages: z.record(z.string(), z.string()),
});
export type CrawlMemento = z.infer<typeof mementoSchema>;

export type CrawlOptions = {
  readonly signal: AbortSignal;
  /** Pages to hand back; other pages are downloaded only when a reader wants them. */
  readonly include?: readonly [URLPattern, ...URLPattern[]];
  /**
   * URLs to keep from a one-step expansion. A page that a list hands back on
   * an origin that no starting URL names is expanded one step: readers find
   * its links on every origin and the sitemaps of its origin's robots.txt, and
   * the crawl keeps only the pages and lists that match a pattern. Omitted,
   * the crawl expands only the starting origins.
   */
  readonly expand?: readonly [URLPattern, ...URLPattern[]];
};

export interface Crawl extends AsyncIterable<
  CrawledPage | CrawlFailure | CrawlProgress | CrawlDeferral
> {
  /** The crawl so far as plain data. The entry handed out last stays unfinished until the next is requested. */
  snapshot(): CrawlMemento;
  /** The caller could not use a page it was handed back, so the page is due again as a failed one. */
  fail(url: string): void;
  /**
   * The caller could not finish the run for a reason that is not one page's,
   * such as a full disk, so the next crawl is due when its starting URLs are
   * due again as failed ones: a host's schedule outlives a failed run.
   */
  abandon(): void;
  /** When the next crawl has a known URL due, starting URLs included; null when none ever is. */
  nextDue(): number | null;
  /**
   * The pages whose last visit failed, which the crawl would hand back: its
   * dead letters, sorted. A page leaves once a visit of it succeeds; a
   * document that failed, such as a sitemap, is none.
   */
  failures(): readonly string[];
}

export class WebCrawler {
  readonly #http: Got;
  readonly #origins: Origins;
  readonly #readers: readonly Reader<unknown, unknown>[];
  readonly #revisit: RevisitPolicy<unknown>;

  /**
   * One crawler for each list of starting URLs, with the revisit policy of
   * its copy. The origins' records are shared: every crawl of one read asks
   * the same record of each origin.
   */
  constructor(
    http: Got,
    origins: Origins,
    readers: readonly Reader<unknown, unknown>[],
    revisit: RevisitPolicy<unknown>,
  ) {
    if (readers.length === 0)
      throw new TypeError('At least one reader is required');
    this.#http = http;
    this.#origins = origins;
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
    const { crawl, urls, pages } =
      memento === null
        ? { crawl: null, urls: {}, pages: {} }
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
      starting: readonly string[],
    ) =>
      new CrawlRun(
        this.#http,
        this.#origins,
        this.#readers,
        this.#revisit,
        options,
        {
          at,
          states,
          entries,
          starting,
          starts: startUrls.map(start),
          known,
          // Only the current starting URLs' pages count.
          pages: new Map(
            Object.entries(pages).filter(([url]) => startUrls.includes(url)),
          ),
          revisits: [...known.values()].flatMap(({ entry }) =>
            startUrls.includes(entry.url)
              ? []
              : [
                  {
                    ...entry,
                    start: null,
                    expand: entry.expand === 'origin' ? null : entry.expand,
                  },
                ],
          ),
        },
      );
    const start = (url: string): Entry => ({
      url,
      listingUrl: url,
      lastModified: null,
      published: null,
      localizedVersions: [],
      hops: 0,
      start: url,
      page: false,
      document: true,
      list: false,
      expand: 'origin',
      within: false,
      priority: 'listing',
      linked: false,
      tolerate: [],
      notes: this.#readers.map(() => null),
      redirect: null,
    });
    const now = Date.now();
    // Each run is timed at its own start, and it requests each starting URL
    // that it never visited or that its revisit policy makes due by then, in
    // a new crawl and in one it continues, whatever ended the last run: as
    // Nutch's generate step selects every due URL, seeds included, in each
    // cycle, so a list is not held up by an expansion budget, an interruption
    // or a block, and the starts' new findings enter the frontier as usual.
    const starting = startUrls.flatMap((url) => {
      const visit = known.get(url);
      return visit === undefined ||
        this.#revisit.due(
          { ...start(url), start: true, startingOrigin: true },
          { ...visit, lastModified: visit.entry.lastModified },
          now,
        )
        ? [start(url)]
        : [];
    });
    if (crawl !== null)
      return run(
        now,
        this.#readers.map((reader, index) =>
          reader.states.parse(crawl.states[index]),
        ),
        [...crawl.pending.map((entry) => this.#restore(entry)), ...starting],
        crawl.origins,
      );
    return run(
      now,
      this.#readers.map((reader) => reader.open()),
      starting,
      [...new Set(startUrls.map((url) => new URL(url).origin))],
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

// A run that still has entries to request, or that held some back for a later run.
class Crawling {}

// A run that requested every entry it had: its memento has no crawl to resume.
class Finished {}

// A run that its caller could not finish: the next crawl continues it when
// the starting URLs are due again as failed ones, or never when null.
class Abandoned {
  readonly due: number | null;
  constructor(due: number | null) {
    this.due = due;
  }
}

class CrawlRun implements Crawl {
  readonly #http: Got;
  readonly #origins: Origins;
  readonly #readers: readonly Reader<unknown, unknown>[];
  readonly #revisit: RevisitPolicy<unknown>;
  readonly #options: CrawlOptions;
  readonly #at: number;
  readonly #states: unknown[];
  readonly #urls: Map<string, KnownUrl>;
  readonly #lanes: Record<Priority, OriginLane<Entry>> = {
    listing: new OriginLane(),
    page: new OriginLane(),
    link: new OriginLane(),
    backfill: new OriginLane(),
  };
  readonly #credit: Record<keyof typeof weights, number> = {
    page: 0,
    link: 0,
    backfill: 0,
  };
  // Every URL pending or downloaded in this run, which a second finding does
  // not bring in again; a skipped page leaves so a later finding can still
  // bring it in. Across runs, only due decides, as Nutch's generator selects
  // each due entry of the crawl database in every cycle.
  readonly #known = new Set<string>();
  // URLs this run handed back as pages: each is handed back once in a run.
  readonly #handed = new Set<string>();
  // URLs this crawl downloads again for a role they add: no reader admits them a second time.
  readonly #again = new Set<string>();
  // Origins of the starting URLs.
  readonly #starting: readonly string[];
  // The starting URLs' entries, which an abandoned run schedules as failed.
  readonly #starts: readonly Entry[];
  // Pending entries of a blocked origin, or of an origin that spent its
  // expansion budget, out of the lanes until a later crawl resumes them.
  readonly #held = new Map<string, Entry>();
  // Each starting URL that answered with a page, with the origin that answered.
  readonly #pages: Map<string, string>;
  // What the entry handed out last leaves pending until the next entry is requested.
  #turn: Turn = idle;
  #phase: Crawling | Finished | Abandoned = new Crawling();
  // Known URLs, offered once this crawl's findings run out, so a finding's fresh provenance comes first.
  readonly #revisits: Entry[];

  constructor(
    http: Got,
    origins: Origins,
    readers: readonly Reader<unknown, unknown>[],
    revisit: RevisitPolicy<unknown>,
    options: CrawlOptions,
    {
      at,
      states,
      entries,
      starting,
      starts,
      known,
      pages,
      revisits,
    }: {
      readonly at: number;
      readonly states: unknown[];
      readonly entries: readonly Entry[];
      readonly starting: readonly string[];
      readonly starts: readonly Entry[];
      readonly known: Map<string, KnownUrl>;
      readonly pages: Map<string, string>;
      readonly revisits: Entry[];
    },
  ) {
    this.#http = http;
    this.#origins = origins;
    this.#readers = readers;
    this.#revisit = revisit;
    this.#options = options;
    this.#at = at;
    this.#states = states;
    this.#urls = known;
    this.#revisits = revisits;
    this.#starting = starting;
    this.#starts = starts;
    this.#pages = pages;
    // Pending entries were admitted when found, in this run or the last.
    for (const entry of entries) this.#add(entry);
  }

  snapshot(): CrawlMemento {
    return structuredClone({
      crawl:
        this.#phase instanceof Finished
          ? null
          : {
              pending: [
                ...(this.#turn.current ? [this.#turn.current] : []),
                ...priorities.flatMap((priority) => [
                  ...this.#lanes[priority].values(),
                ]),
                ...this.#held.values(),
              ],
              states: this.#states,
              origins: [...this.#starting],
            },
      urls: Object.fromEntries(this.#urls),
      pages: Object.fromEntries(this.#pages),
    });
  }

  fail(url: string): void {
    const visit =
      this.#turn.visit?.after.entry.url === url ? this.#turn.visit : undefined;
    const before = visit ? visit.before : this.#urls.get(url);
    const entry = visit?.after.entry ?? before?.entry;
    if (entry === undefined)
      throw new TypeError(`The crawl did not hand back ${url}`);
    const after = this.#schedule(
      entry,
      'failed',
      null,
      { kind: 'failed' },
      before,
    );
    if (visit) this.#turn = { ...this.#turn, visit: { before, after } };
    else this.#urls.set(url, after);
  }

  abandon(): void {
    let due: number | null = null;
    for (const entry of this.#starts) {
      const schedule = this.#schedule(
        entry,
        'failed',
        null,
        { kind: 'failed' },
        this.#urls.get(entry.url),
      );
      if (schedule.due !== null && (due === null || schedule.due < due))
        due = schedule.due;
    }
    this.#phase = new Abandoned(due);
  }

  nextDue(): number | null {
    if (this.#phase instanceof Abandoned) return this.#phase.due;
    // A crawl held back by blocks continues when the first one closes; one
    // held back by a spent expansion budget, or by a block that closed, is
    // due again at once.
    if (this.#phase instanceof Crawling && this.#held.size > 0)
      return Math.min(
        ...[...this.#held.values()].map(
          ({ url }) => this.#origins.until(new URL(url).origin) ?? this.#at,
        ),
      );
    const known = [...this.#urls.values()];
    if (this.#turn.visit) known.push(this.#turn.visit.after);
    let next: number | null = null;
    for (const { due } of known)
      if (due !== null && (next === null || due < next)) next = due;
    return next;
  }

  failures(): readonly string[] {
    // The last visit, until the next entry is requested, is newer than the
    // URL's record.
    const known = new Map(this.#urls);
    if (this.#turn.visit)
      known.set(this.#turn.visit.after.entry.url, this.#turn.visit.after);
    return [...known.values()]
      .filter(
        ({ entry, last }) => last.kind === 'failed' && this.#handedBack(entry),
      )
      .map(({ entry }) => entry.url)
      .toSorted();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<
    CrawledPage | CrawlFailure | CrawlProgress | CrawlDeferral
  > {
    const { signal } = this.#options;
    signal.throwIfAborted();
    for (;;) {
      this.#commit();
      const next = await this.#next();
      if (!next) break;
      if ('failure' in next) {
        yield next.failure;
        continue;
      }
      const { entry, included, wanted } = next;
      const before = this.#urls.get(entry.url);
      const page = this.#handedBack(entry);
      const { origin } = new URL(entry.url);
      await this.#origins.pace(origin, signal);
      let response: Response;
      try {
        response = await this.#http(entry.url, {
          signal,
          responseType: 'buffer',
          throwHttpErrors: false,
          // A redirect is a request of its own, which passes the record of
          // its own origin, as Heritrix and StormCrawler make the Location
          // an outlink rather than follow it.
          followRedirect: false,
          retry: this.#origins.retry,
          // Lets the caller's Got hooks tell pages it reads from documents readers read.
          context:
            entry.redirect === null
              ? { page }
              : { ...entry.redirect.context, page },
        });
      } catch (cause) {
        signal.throwIfAborted();
        const errorResponse =
          cause instanceof RequestError ? cause.response : undefined;
        this.#visited(entry, 'failed', null, { kind: 'failed' }, before);
        yield this.#tolerates(entry, errorResponse?.statusCode)
          ? { progress: entry.url, routes: [] }
          : this.#failure(entry, page, errorResponse?.url ?? entry.url, cause);
        continue;
      }
      signal.throwIfAborted();
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const { statusCode } = response;
      const tolerated = this.#tolerates(entry, statusCode);
      const until = this.#origins.answered(
        entry.url,
        statusCode,
        headers.get('retry-after'),
        tolerated,
      );
      if (until !== null) {
        // A block is the host's, not the page's: the URL goes back to the
        // frontier, and the revisit policy does not schedule it.
        this.#held.set(entry.url, entry);
        this.#turn = { ...this.#turn, current: null };
        yield this.#failure(
          entry,
          page,
          entry.url,
          new Error(
            `${origin} answered ${statusCode}, so the crawl requests nothing there until ${new Date(until).toISOString()}`,
            { cause: new HTTPError(response) },
          ),
        );
        continue;
      }
      const location = redirectTarget(statusCode, headers, entry.url);
      if (location !== null) {
        yield this.#redirect(
          entry,
          response,
          headers,
          location,
          wanted,
          before,
        );
        continue;
      }
      const failed = statusCode < 200 || statusCode > 299;
      let change: Change = 'unknown';
      if (failed)
        this.#visited(
          entry,
          [404, 410].includes(statusCode) ? 'gone' : 'failed',
          headers,
          { kind: 'failed' },
          before,
        );
      else {
        const digest = createHash('sha256')
          .update(response.rawBody)
          .digest('hex');
        if (before !== undefined && before.last.kind === 'fetched')
          change = before.last.digest === digest ? 'unmodified' : 'modified';
        this.#visited(
          entry,
          change,
          headers,
          { kind: 'fetched', digest },
          before,
        );
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
        if (this.#turn.visit === null) return;
        const { before, after } = this.#turn.visit;
        const limit = this.#at + within;
        if (after.due === null || limit < after.due)
          this.#turn = {
            ...this.#turn,
            visit: { before, after: { ...after, due: limit } },
          };
      };
      // A starting URL is read as a list too, as the readers of lists do.
      const list = (entry.list || entry.start !== null) && isHtml(type);
      if (
        entry.start !== null &&
        !failed &&
        (isHtml(type) || type === 'text/markdown')
      )
        this.#pages.set(entry.start, origin);
      // Each URL in scope that the response names, found or not, as Heritrix
      // records every outlink of a URI and Nutch inverts them into inlinks.
      const named = new Map<string, Naming>();
      let complete = true;
      // Readers are independent: one that cannot read the response is reported
      // for it, and the others still read it. The page itself did not fail.
      for (const [index, reader] of this.#readers.entries()) {
        try {
          const findings = await reader.read(
            {
              response,
              headers,
              type,
              request: this.#request(entry),
              note: entry.notes[index],
              wanted: wanted[index] === true,
              revisitWithin,
            },
            this.#states[index],
          );
          if (findings === null) {
            complete = false;
            continue;
          }
          for (const finding of findings) {
            if (!this.#keeps(finding, entry)) continue;
            const next = this.#entry(finding, entry, index, list);
            if (finding.naming !== null && this.#scopes(next))
              named.set(
                next.url,
                strongest(named.get(next.url), finding.naming),
              );
            this.#enqueue(next);
          }
        } catch (cause) {
          signal.throwIfAborted();
          complete = false;
          yield this.#failure(entry, false, entry.url, cause);
        }
      }
      signal.throwIfAborted();
      const routes: ListingRoutes[] = [
        {
          listingUrl: entry.url,
          complete,
          routes: [...named].map(([url, naming]) => ({ url, ...naming })),
        },
      ];
      // A URL downloaded again for a role it adds is a page already handed back.
      if (included && !failed && !this.#handed.has(entry.url)) {
        this.#turn = { ...this.#turn, hand: entry.url };
        yield {
          url: entry.url,
          listingUrl: entry.listingUrl,
          lastModified: entry.lastModified,
          published: entry.published,
          localizedVersions: entry.localizedVersions,
          response,
          change,
          routes,
        };
      } else yield { progress: entry.url, routes };
    }
    // Entries of a blocked or spent origin remain: the crawl is unfinished.
    if (this.#held.size > 0) return;
    for (const [url, { entry, last }] of this.#urls)
      if (
        last.kind === 'fetched' &&
        !this.#known.has(url) &&
        this.#hands(entry)
      )
        yield {
          deferred: {
            url,
            listingUrl: entry.listingUrl,
            lastModified: entry.lastModified,
            published: entry.published,
            localizedVersions: entry.localizedVersions,
          },
        };
    this.#phase = new Finished();
  }

  // A redirect is a visit of the requested URL, whose body is the URL it
  // redirects to, and the Location is a request of its own that continues
  // the entry: it has the entry's roles, provenance and admissions, as
  // StormCrawler transfers a URL's metadata to its redirect target, and it
  // passes the robots.txt, the block and the delay of its own origin.
  #redirect(
    entry: Entry,
    response: Response,
    headers: Headers,
    location: string,
    wanted: readonly boolean[],
    before: KnownUrl | undefined,
  ): CrawlFailure | CrawlProgress {
    const hops = entry.redirect === null ? 1 : entry.redirect.hops + 1;
    if (hops > maxRedirects) {
      this.#visited(entry, 'failed', headers, { kind: 'failed' }, before);
      return this.#failure(
        entry,
        this.#handedBack(entry),
        entry.url,
        new Error(`More than ${maxRedirects} redirects`, {
          cause: new HTTPError(response),
        }),
      );
    }
    // A redirect is its own outcome, as Nutch's STATUS_FETCH_REDIR_TEMP and
    // _PERM and StormCrawler's REDIRECTION: its target is what it says, so a
    // target that stays is unmodified and one that moves is modified.
    const permanent = [301, 308].includes(response.statusCode);
    this.#visited(
      entry,
      {
        redirect: location,
        permanent,
        change:
          before === undefined || before.last.kind !== 'redirect'
            ? 'unknown'
            : before.last.target === location
              ? 'unmodified'
              : 'modified',
      },
      headers,
      { kind: 'redirect', target: location, permanent },
      before,
    );
    this.#enqueue({
      ...entry,
      url: location,
      redirect: {
        hops,
        wanted: [...wanted],
        included: this.#hands(entry),
        context: contextSchema.parse(
          Object.fromEntries(
            Object.entries(response.request.options.context).filter(
              ([key]) => key !== 'page',
            ),
          ),
        ),
      },
    });
    return {
      progress: entry.url,
      routes: [
        {
          listingUrl: entry.url,
          complete: true,
          routes: [{ url: location, how: 'redirect', text: null }],
        },
      ],
    };
  }

  #visited(
    entry: Entry,
    outcome: Outcome,
    headers: Headers | null,
    last: Last,
    before: KnownUrl | undefined,
  ) {
    this.#turn = {
      ...this.#turn,
      visit: {
        before,
        after: this.#schedule(entry, outcome, headers, last, before),
      },
    };
  }

  #schedule(
    entry: Entry,
    outcome: Outcome,
    headers: Headers | null,
    last: Last,
    before: KnownUrl | undefined,
  ): KnownUrl {
    const { due, history } = this.#revisit.schedule(
      {
        request: this.#request(entry),
        outcome,
        headers,
        at: this.#at,
      },
      before?.history ?? null,
    );
    return { entry, last, due, history };
  }

  #commit() {
    const { hand, visit } = this.#turn;
    if (hand !== null) this.#handed.add(hand);
    if (visit !== null) this.#urls.set(visit.after.entry.url, visit.after);
    this.#turn = { ...this.#turn, hand: null, visit: null };
  }

  // The next entry worth a download. One nobody needs, or that robots.txt
  // disallows, is dropped without using its lane's turn, so turns are spent on
  // downloads: a lane full of skipped links cannot hand its share to backfill.
  async #next(): Promise<
    | {
        readonly entry: Entry;
        readonly included: boolean;
        readonly wanted: readonly boolean[];
      }
    | { readonly failure: CrawlFailure }
    | undefined
  > {
    const { signal } = this.#options;
    for (;;) {
      for (let lane = this.#lane(); lane; lane = this.#lane())
        for (
          let entry = lane.take(this.#ready);
          entry;
          entry = lane.take(this.#ready)
        ) {
          const { origin } = new URL(entry.url);
          const included = this.#hands(entry);
          const needed = entry.start !== null || entry.document || included;
          // A URL that nobody needs and that no reader would admit, such as a
          // list's link to a website that include does not select, is dropped
          // before its origin is asked anything: it costs that website no
          // request and fails nothing, as Scrapy drops an off-site request
          // before its robots.txt check.
          if (!needed && !this.#wouldAdmit(entry)) {
            this.#known.delete(entry.url);
            continue;
          }
          if (this.#origins.until(origin) !== null) {
            this.#held.set(entry.url, entry);
            continue;
          }
          // The documents that a one-step expansion reads on an origin that
          // no starting URL names, such as its robots.txt sitemaps, spend the
          // origin's budget for each read; the rest wait in the frontier for
          // the next run, as Nutch's generate.max.count leaves a host's
          // surplus URLs in the crawl database for the next cycle.
          const budgeted =
            entry.document && entry.within && !this.#starting.includes(origin);
          if (budgeted && !this.#origins.expands(origin)) {
            this.#held.set(entry.url, entry);
            continue;
          }
          if (entry.url !== `${origin}/robots.txt`) {
            const rules = await this.#origins.rules(origin, signal);
            if (!(rules instanceof RobotsRules)) {
              this.#held.set(entry.url, entry);
              this.#turn = { ...this.#turn, current: null };
              return {
                failure: this.#failure(
                  entry,
                  this.#handedBack(entry),
                  `${origin}/robots.txt`,
                  new Error(
                    `${origin} could not give its robots.txt (${Error.isError(rules.cause) ? rules.cause.message : String(rules.cause)}), so the crawl requests nothing there until ${new Date(rules.until).toISOString()}`,
                    { cause: rules.cause },
                  ),
                ),
              };
            }
            // A disallowed URL is no failure: the crawl leaves it out, and the
            // revisit policy does not schedule it.
            if (!rules.allows(entry.url)) continue;
          }
          // A reader's budget counts admissions, and a second download of a
          // URL is none; a redirect carries the admissions of its request.
          const wanted = this.#again.delete(entry.url)
            ? this.#readers.map(() => false)
            : entry.redirect === null
              ? this.#readers.map((reader, index) =>
                  reader.wants(this.#request(entry), this.#states[index]),
                )
              : entry.redirect.wanted;
          if (needed || wanted.includes(true)) {
            if (budgeted) this.#origins.spend(origin);
            this.#turn = { ...this.#turn, current: entry };
            return { entry, included, wanted };
          }
          this.#known.delete(entry.url);
        }
      if (this.#revisits.length === 0) break;
      // Nutch's generate step: a known URL that is due returns even when nothing lists it in this crawl.
      for (const entry of this.#revisits.splice(0)) this.#enqueue(entry);
    }
    this.#turn = { ...this.#turn, current: null };
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

  // Whether the origin's delay and slowdown have passed, so a request to it waits for nothing.
  readonly #ready = (origin: string) => this.#origins.ready(origin);

  // Whether a reader would admit the entry, asked on copies of the readers'
  // states, which are plain data, so the question spends no budget: a reader
  // admits for real only after the rules of the origin allow the URL. A
  // redirect carries the admissions of the request that it continues.
  #wouldAdmit(entry: Entry) {
    if (entry.redirect !== null) return entry.redirect.wanted.includes(true);
    return this.#readers.some((reader, index) =>
      reader.wants(this.#request(entry), structuredClone(this.#states[index])),
    );
  }

  #includes(url: string) {
    return (
      this.#options.include === undefined ||
      this.#options.include.some((pattern) => pattern.test(url))
    );
  }

  // A page that the crawl hands back: include selects it, and no reader
  // reads it as a document.
  #handedBack(entry: Entry) {
    return this.#hands(entry) && !entry.document;
  }

  // Whether the crawl hands the entry back as a page: a page that include
  // selects, or the redirect target of one, as Heritrix's
  // TransclusionDecideRule admits a redirect hop that leaves the scope.
  #hands(entry: Entry) {
    return (
      entry.page &&
      (this.#includes(entry.url) ||
        (entry.redirect !== null && entry.redirect.included))
    );
  }

  // The crawl's scope, as the URL filter of a crawler (Introduction to
  // Information Retrieval, figure 20.1) and Heritrix's scope: what a one-step
  // expansion finds is kept only when it matches the expand patterns, except
  // the documents, such as robots.txt and its sitemaps, whose own findings
  // are kept by the same rule.
  #keeps(finding: Finding<unknown>, parent: Entry) {
    if (parent.expand !== 'step' && !parent.within) return true;
    return (
      (!finding.page && !finding.list) ||
      (this.#options.expand?.some((pattern) => pattern.test(finding.url)) ??
        false)
    );
  }

  // The entry as readers and the revisit policy see it: whether it is a
  // starting URL, or on the origin of a starting page.
  #request(entry: Entry): CrawlRequest {
    const { origin } = new URL(entry.url);
    return {
      ...entry,
      start: entry.start !== null,
      startingOrigin:
        entry.start !== null ||
        this.#pages.values().some((page) => page === origin),
    };
  }

  // Whether a URL that a response names is one the crawl keeps, as it decides
  // before a download: a document, a page that include selects, a URL that a
  // crawl already downloaded, or a page that a reader would admit now. A
  // list's link to a website that include does not select, such as a list's
  // license on GitHub, is out of scope.
  #scopes(next: Entry) {
    return (
      next.document ||
      (next.page && this.#includes(next.url)) ||
      this.#urls.has(next.url) ||
      this.#turn.visit?.after.entry.url === next.url ||
      this.#wouldAdmit(next)
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
      published: entry.published,
      localizedVersions: entry.localizedVersions,
      error: new CrawlError(url, cause, page),
    };
  }

  #entry(
    finding: Finding<unknown>,
    parent: Entry,
    index: number,
    list: boolean,
  ): Entry {
    const notes: unknown[] = this.#readers.map(() => null);
    notes[index] = finding.note;
    const url = webUrl(finding.url, parent.url);
    const expansion = parent.expand === 'step' || parent.within;
    return {
      url,
      listingUrl: parent.url,
      lastModified: finding.lastModified,
      published: finding.published,
      localizedVersions: finding.localizedVersions,
      hops: parent.hops + (finding.linked ? 1 : 0),
      start: null,
      page: finding.page,
      document: !finding.page,
      list: finding.list,
      // A page that a list hands back on another website is expanded one
      // step; a sitemap's or a feed's item is not, and what an expansion
      // finds is not expanded again.
      expand:
        this.#options.expand !== undefined &&
        list &&
        !expansion &&
        finding.page &&
        !finding.linked &&
        !this.#starting.includes(new URL(url).origin)
          ? 'step'
          : null,
      within: expansion,
      priority: finding.priority,
      linked: finding.linked,
      tolerate: finding.tolerate,
      notes,
      redirect: null,
    };
  }

  // A known URL that is not due stays out of this run, whatever finds it.
  // Reader admission comes after, so a URL left out spends no reader budget.
  #enqueue(next: Entry) {
    if (this.#pending(next.url) === undefined) {
      if (this.#known.has(next.url)) {
        // This run downloaded the URL: it goes again only for a role that
        // download did not have, with every role, so Got's cache revalidates it.
        const visited = (
          this.#turn.visit?.after.entry.url === next.url
            ? this.#turn.visit.after
            : this.#urls.get(next.url)
        )?.entry;
        if (visited === undefined) return;
        // A page role matters only for a page the crawl hands back, and every
        // reader already reads a starting URL as it reads a list.
        const addsRole =
          (this.#hands(next) && !visited.page) ||
          (next.list && !visited.list && visited.start === null) ||
          (next.expand === 'step' && visited.expand === null);
        if (!addsRole) return;
        const again = { ...visited, priority: next.priority };
        merge(again, next);
        next = again;
        this.#again.add(next.url);
      } else {
        const known = this.#urls.get(next.url);
        if (
          known !== undefined &&
          !this.#revisit.due(
            this.#request(next),
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
      this.#lanes[next.priority].set(next);
      return;
    }
    const { priority } = pending;
    merge(pending, next);
    if (pending.priority !== priority) {
      this.#lanes[priority].delete(pending.url);
      this.#lanes[pending.priority].set(pending);
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

// The redirects that one request follows, as Got's maxRedirects; a longer chain fails, as Got's MaxRedirectsError does.
const maxRedirects = 10;

// The Got context of a request that a redirect carries to its next request, as plain data, so the memento keeps it.
const contextSchema = z.record(z.string(), z.json());

// The URL that a response redirects to: a redirect status that Got follows,
// 304 aside, with an HTTP(S) Location; null for any other response.
function redirectTarget(status: number, headers: Headers, url: string) {
  const location = headers.get('location');
  return location !== null && [300, 301, 302, 303, 307, 308].includes(status)
    ? httpUrl(location, url)
    : null;
}

// The naming of a URL that one response names in two ways: the more specific
// way, with the first text that either gives.
function strongest(before: Naming | undefined, next: Naming): Naming {
  if (before === undefined) return next;
  const [first, second] =
    routeHows.indexOf(next.how) < routeHows.indexOf(before.how)
      ? [next, before]
      : [before, next];
  return { how: first.how, text: first.text ?? second.text };
}

// Folds a finding into an entry for the same URL: roles only grow.
function merge(pending: Entry, next: Entry) {
  // A starting URL has no provenance of its own: its first page finding gives it one.
  if (
    (pending.linked && !next.linked) ||
    (pending.start !== null && !pending.page && next.page)
  ) {
    pending.listingUrl = next.listingUrl;
    pending.lastModified = next.lastModified;
    pending.published = next.published;
    pending.localizedVersions = next.localizedVersions;
    pending.linked = next.linked;
  }
  // A URL that is also a page counts the hops of its page findings; a document's do not lower them.
  if (next.page === pending.page)
    pending.hops = Math.min(pending.hops, next.hops);
  else if (next.page) {
    pending.hops = next.hops;
    pending.page = true;
  }
  if (pending.start === null) pending.start = next.start;
  pending.document ||= next.document;
  pending.list ||= next.list;
  if (pending.expand !== 'origin' && next.expand !== null)
    pending.expand = next.expand;
  // A finding outside every expansion keeps all that the URL finds.
  pending.within &&= next.within;
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
  // A URL that redirects lead to continues each of their requests.
  const { redirect } = next;
  if (redirect !== null)
    pending.redirect =
      pending.redirect === null
        ? redirect
        : {
            hops: Math.min(pending.redirect.hops, redirect.hops),
            wanted: pending.redirect.wanted.map(
              (wanted, index) => wanted || redirect.wanted[index] === true,
            ),
            included: pending.redirect.included || redirect.included,
            context: pending.redirect.context,
          };
}
