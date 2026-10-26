import { type Got, HTTPError, RequestError, type Response } from 'got';
import { z } from 'zod';

import type { Finding, PageLocation, Reader } from './reader.ts';
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

const entrySchema = z.object({
  url: z.string(),
  listingUrl: z.string(),
  lastModified: z.string().nullable(),
  hops: z.number().int().nonnegative(),
  start: z.boolean(),
  page: z.boolean(),
  // Some reader reads it as a document; documents are downloaded before pages.
  document: z.boolean(),
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

export interface Crawl extends AsyncIterable<CrawledPage | CrawlFailure> {
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
  readonly #documents = new Map<string, Entry>();
  readonly #pages = new Map<string, Entry>();
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
        ...this.#documents.values(),
        ...this.#pages.values(),
      ],
      known: [...this.#known],
      states: this.#states,
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CrawledPage | CrawlFailure> {
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
        if (!this.#tolerates(entry, errorResponse?.statusCode))
          yield this.#failure(
            entry,
            page,
            errorResponse?.url ?? entry.url,
            cause,
          );
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
      if (included && !failed)
        yield {
          url: entry.url,
          listingUrl: entry.listingUrl,
          lastModified: entry.lastModified,
          response,
        };
    }
  }

  #next() {
    const lane = this.#documents.size > 0 ? this.#documents : this.#pages;
    const [entry] = lane.values();
    if (entry) lane.delete(entry.url);
    this.#current = entry ?? null;
    return entry;
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
      linked: finding.linked,
      tolerate: finding.tolerate,
      notes,
    };
  }

  #enqueue(next: Entry) {
    const pending = this.#documents.get(next.url) ?? this.#pages.get(next.url);
    if (!pending) {
      if (this.#known.has(next.url)) return;
      this.#known.add(next.url);
      (next.document ? this.#documents : this.#pages).set(next.url, next);
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
    if (!pending.document && next.document) {
      this.#pages.delete(pending.url);
      this.#documents.set(pending.url, pending);
    }
    pending.document ||= next.document;
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
