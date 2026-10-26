import { type Got, HTTPError, RequestError, type Response } from 'got';
import { z } from 'zod';

import {
  type Finding,
  type PageLocation,
  type Priority,
  type Reader,
  priorities,
} from './reader.ts';
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

export type CrawledPage = PageLocation & { readonly response: Response };
export type CrawlFailure = PageLocation & {
  readonly error: CrawlError;
  /** The URL is a page the crawl would have handed back, not a starting URL or a document. */
  readonly page: boolean;
};
/** A URL the crawl downloaded for its readers without handing it back: a moment to take a snapshot. */
export type CrawlProgress = { readonly progress: string };

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
  priority: z.enum(priorities),
  // Its provenance came from a link, so a listing's provenance replaces it.
  linked: z.boolean(),
  tolerate: z.union([z.array(z.number().int()).readonly(), z.literal('any')]),
  notes: z.array(z.unknown()),
});
type Entry = z.infer<typeof entrySchema>;

const snapshotSchema = z.object({
  pending: z.array(entrySchema),
  known: z.array(z.string()),
  states: z.array(z.unknown()),
});
export type CrawlSnapshot = z.infer<typeof snapshotSchema>;

export type CrawlOptions = {
  readonly signal: AbortSignal;
  /** Pages to hand back; other pages are downloaded only when a reader wants them. */
  readonly include?: readonly URLPattern[];
  /** Pages already known, such as earlier failures, handed back like listed pages before other pages. */
  readonly pages?: readonly PageLocation[];
};

export interface Crawl extends AsyncIterable<
  CrawledPage | CrawlFailure | CrawlProgress
> {
  /** The crawl so far as plain data. The entry handed out last stays unfinished until the next is requested. */
  snapshot(): CrawlSnapshot;
}

export class WebCrawler {
  readonly #http: Got;
  readonly #readers: readonly Reader<unknown, unknown>[];

  constructor(http: Got, readers: readonly Reader<unknown, unknown>[]) {
    if (readers.length === 0)
      throw new TypeError('At least one reader is required');
    this.#http = http;
    this.#readers = readers.slice();
  }

  run(starts: readonly string[], options: CrawlOptions): Crawl {
    return new CrawlRun(
      this.#http,
      this.#readers,
      options,
      this.#readers.map((reader) => reader.open()),
      [
        ...starts.map((start) => {
          const url = webUrl(start, start);
          return {
            url,
            listingUrl: url,
            lastModified: null,
            hops: 0,
            start: true,
            page: false,
            document: true,
            priority: 'listing' as const,
            linked: false,
            tolerate: [],
            notes: this.#readers.map(() => null),
          };
        }),
        ...this.#pages(options),
      ],
      [],
    );
  }

  resume(snapshot: unknown, options: CrawlOptions): Crawl {
    const { pending, known, states } = snapshotSchema.parse(snapshot);
    return new CrawlRun(
      this.#http,
      this.#readers,
      options,
      this.#readers.map((reader, index) => reader.states.parse(states[index])),
      [
        ...this.#pages(options),
        ...pending.map((entry) => ({
          ...entry,
          notes: this.#readers.map((reader, index) =>
            reader.notes.nullable().parse(entry.notes[index]),
          ),
        })),
      ],
      known,
    );
  }

  // Entries enter before the known URLs are restored, so a caller's page returns even after it failed.
  #pages(options: CrawlOptions): Entry[] {
    return (options.pages ?? []).map((page) => ({
      ...page,
      url: webUrl(page.url, page.listingUrl),
      hops: 0,
      start: false,
      page: true,
      document: false,
      priority: 'page',
      linked: false,
      tolerate: [],
      notes: this.#readers.map(() => null),
    }));
  }
}

class CrawlRun implements Crawl {
  readonly #http: Got;
  readonly #readers: readonly Reader<unknown, unknown>[];
  readonly #options: CrawlOptions;
  readonly #states: unknown[];
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
  // Every URL pending or downloaded; a skipped page leaves so a later finding can still bring it in.
  readonly #known = new Set<string>();
  #current: Entry | null = null;

  constructor(
    http: Got,
    readers: readonly Reader<unknown, unknown>[],
    options: CrawlOptions,
    states: unknown[],
    entries: readonly Entry[],
    known: readonly string[],
  ) {
    this.#http = http;
    this.#readers = readers;
    this.#options = options;
    this.#states = states;
    for (const entry of entries) this.#enqueue(entry);
    for (const url of known) this.#known.add(url);
  }

  snapshot(): CrawlSnapshot {
    return structuredClone({
      pending: [
        ...(this.#current ? [this.#current] : []),
        ...priorities.flatMap((priority) => [
          ...this.#lanes[priority].values(),
        ]),
      ],
      known: [...this.#known],
      states: this.#states,
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<
    CrawledPage | CrawlFailure | CrawlProgress
  > {
    const { signal } = this.#options;
    signal.throwIfAborted();
    for (;;) {
      const entry = this.#next();
      if (!entry) break;
      const included = entry.page && this.#includes(entry.url);
      const page = included && !entry.document;
      const wanted = this.#readers.map((reader, index) =>
        reader.wants(entry, this.#states[index]),
      );
      if (
        !entry.start &&
        !entry.document &&
        !included &&
        !wanted.includes(true)
      ) {
        this.#known.delete(entry.url);
        continue;
      }
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
        yield this.#tolerates(entry, errorResponse?.statusCode)
          ? { progress: entry.url }
          : this.#failure(entry, page, errorResponse?.url ?? entry.url, cause);
        continue;
      }
      signal.throwIfAborted();
      const failed = !response.ok || response.statusCode === 304;
      if (failed && !this.#tolerates(entry, response.statusCode)) {
        yield this.#failure(entry, page, response.url, new HTTPError(response));
        continue;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      const type =
        headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ??
        null;
      try {
        for (const [index, reader] of this.#readers.entries())
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
        yield this.#failure(entry, page, response.url, cause);
        continue;
      }
      signal.throwIfAborted();
      yield included && !failed
        ? {
            url: entry.url,
            listingUrl: entry.listingUrl,
            lastModified: entry.lastModified,
            response,
          }
        : { progress: entry.url };
    }
  }

  #next() {
    const [entry] = this.#lane()?.values() ?? [];
    if (entry) this.#lanes[entry.priority].delete(entry.url);
    this.#current = entry ?? null;
    return entry;
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
      priority: finding.priority,
      linked: finding.linked,
      tolerate: finding.tolerate,
      notes,
    };
  }

  #enqueue(next: Entry) {
    const pending = priorities
      .map((priority) => this.#lanes[priority].get(next.url))
      .find((entry) => entry !== undefined);
    if (!pending) {
      if (this.#known.has(next.url)) return;
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
