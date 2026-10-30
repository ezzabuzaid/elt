import { hash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

import { z } from 'zod';

import {
  Catalog,
  type CopyConfiguration,
  type KeptGroup,
  type Partition,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
  diffGroupedSnapshot,
  validateRecords,
} from '@workspace/elt';
import { AlwaysRevisit, WebCrawler } from '@workspace/sdk-web-crawler';

import { webHttp } from './http/web-http.ts';
import { WebStream } from './web-stream.ts';

const provenance = {
  inputUrl: {
    type: 'string',
    description: 'The chosen website, sitemap or feed; the partition key.',
  },
  pageUrl: {
    type: 'string',
    description:
      'Discovered page URL, preserving queries and trailing slashes.',
  },
  listingUrl: {
    type: 'string',
    description: 'The listing that first supplied the page URL.',
  },
  lastModified: {
    type: ['string', 'null'],
    description:
      'Raw modification hint of the listing, such as a sitemap lastmod or an Atom updated; not a change cursor or publication date.',
  },
  published: {
    type: ['string', 'null'],
    format: 'date-time',
    description:
      "When the listing says the page was published, such as an RSS pubDate or an Atom published; null when it gives no date that parses. Not the page's own date metadata.",
  },
} as const;

const saved = z.object({
  diff: z.unknown(),
  // The crawler's memento: its unfinished crawl and every URL it visited, failed pages too.
  crawl: z.unknown(),
});

// A page that the stream's extractor could not read: recorded and failed back to the crawler, while the other pages continue.
class PageFailure extends Error {
  readonly failure: Error;
  constructor(failure: Error) {
    super(failure.message, { cause: failure });
    this.failure = failure;
  }
}

function pageFailure(error: unknown): never {
  throw Error.isError(error) ? new PageFailure(error) : error;
}

const inputUrls = z.array(z.url({ protocol: /^https?$/ })).min(1);

/** A web stream without a usable input: none, or a URL that is not http or https. The user chooses the inputs, so only the user can fix it. */
export class InputError extends Error {}

export class WebSource extends Source {
  readonly identity = 'web-pages';
  protected readonly catalog: Catalog;
  // Each stream's web stream and the inputs that it crawls, by stream name.
  readonly #streams: ReadonlyMap<
    string,
    { readonly stream: WebStream; readonly inputs: readonly string[] }
  >;
  // Where the HTTP cache lives is the host's decision, like a destination's path.
  readonly #cachePath: string;
  // The crawler's name, which every request carries and robots.txt groups
  // name, is the host's too: "WhatIsGoingOn/0.1 (+https://…)" matches the
  // group "User-agent: WhatIsGoingOn" (RFC 9309 §2.2.1).
  readonly #userAgent: string;
  protected override readonly configErrors = [InputError];
  // Each input's earliest due URL by stream, as its last crawl left it; null when its crawl failed or nothing is ever due.
  readonly #due = new Map<string, Map<string, number | null>>();
  #extracted = Promise.withResolvers<void>();
  constructor(options: {
    // Each web stream with the inputs that it crawls, as an Airbyte
    // declarative source has many streams, each with its own requests.
    streams: readonly {
      readonly stream: WebStream;
      readonly inputs: readonly string[];
    }[];
    cachePath: string;
    userAgent: string;
  }) {
    super();
    this.#cachePath = z.string().min(1).parse(options.cachePath);
    this.#userAgent = z.string().min(1).parse(options.userAgent);
    const streams = z
      .array(z.object({ stream: z.instanceof(WebStream), inputs: z.unknown() }))
      .min(1)
      .parse(options.streams)
      .map(({ stream, inputs }) => {
        const parsed = inputUrls.safeParse(inputs);
        if (!parsed.success)
          throw new InputError(
            `The web stream ${stream.name} needs at least one http or https input`,
            { cause: parsed.error },
          );
        return { stream, inputs: parsed.data };
      });
    this.catalog = new Catalog(
      streams.map(({ stream }) => {
        const properties = { ...provenance, ...stream.extractor.properties };
        return new Stream({
          name: stream.name,
          jsonSchema: {
            type: 'object',
            description:
              'Records extracted from the pages crawled for each chosen input. Incremental scans retain records absent from later listings.',
            properties,
            required: Object.keys(properties),
          },
          primaryKey: ['inputUrl', ...stream.primaryKey],
          partitionKey: ['inputUrl'],
          supportedSyncModes: ['full_refresh', 'incremental'],
          sourceDefinedCursor: true,
        });
      }),
    );
    this.#streams = new Map(streams.map((entry) => [entry.stream.name, entry]));
  }
  #entry({ name }: Stream) {
    const entry = this.#streams.get(name);
    if (entry === undefined)
      throw new TypeError(`Stream ${name} is not a web stream of this source`);
    return entry;
  }
  coverage(stream: Stream) {
    const {
      stream: { include },
      inputs,
    } = this.#entry(stream);
    return {
      description:
        'Records extracted from the pages crawled from chosen websites and feeds that match the configured URL patterns; listing disappearance does not imply deletion.',
      selection: {
        inputs,
        ...(include === undefined
          ? {}
          : {
              include: include.map((pattern) => ({
                protocol: pattern.protocol,
                username: pattern.username,
                password: pattern.password,
                hostname: pattern.hostname,
                port: pattern.port,
                pathname: pattern.pathname,
                search: pattern.search,
                hash: pattern.hash,
              })),
            }),
      },
    };
  }
  async currentAsOf() {
    return null;
  }
  protected async open() {
    return new AsyncDisposableStack();
  }
  protected override partitions(stream: Stream) {
    return this.#entry(stream).inputs.map((inputUrl) => ({ inputUrl }));
  }
  // Each stream checks again when its earliest known URL is due, as its
  // inputs' last crawls left it, and only the streams that are due are read.
  // The watch runs a crawl beside this loop, so a stream waits until each of
  // its inputs' crawls since its last check has ended.
  protected async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    yield streams;
    const dueAt = (stream: Stream) => {
      const due = this.#due.get(stream.name);
      return due === undefined || due.size < this.#entry(stream).inputs.length
        ? Infinity
        : Math.min(...[...due.values()].map((at) => at ?? Infinity));
    };
    for (;;) {
      const extracted = this.#extracted.promise;
      const due = streams.filter((stream) => dueAt(stream) <= Date.now());
      if (due.length === 0) {
        const next = Math.min(...streams.map(dueAt));
        const waiting = new AbortController();
        try {
          await Promise.race([
            setTimeout(Math.min(next - Date.now(), 2 ** 31 - 1), undefined, {
              signal: AbortSignal.any([signal, waiting.signal]),
            }),
            extracted,
          ]);
        } finally {
          waiting.abort();
        }
        signal.throwIfAborted();
        continue;
      }
      for (const stream of due) this.#due.delete(stream.name);
      yield due;
    }
  }
  protected async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    _context: AsyncDisposable,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const inputUrl = z.string().parse(partition?.inputUrl);
    const { stream } = this.#entry(configuration.stream);
    let due: number | null = null;
    try {
      const previous =
        state === null ? { diff: null, crawl: null } : saved.parse(state);
      let diff: unknown = previous.diff;
      await using client = await webHttp(
        this.#cachePath,
        this.#userAgent,
        signal,
      );
      const { http, signal: requestSignal } = client;
      const run = stream.extractor.open(http);
      const crawler = new WebCrawler(
        http.extend({
          hooks: {
            beforeRequest: [
              (options) => {
                if (options.context.page === true && run.negotiation !== null)
                  options.headers.accept = run.negotiation.accept;
              },
            ],
            beforeRedirect:
              run.negotiation === null ? [] : [run.negotiation.beforeRedirect],
          },
        }),
        stream.readers,
        // A full refresh replaces the collection, so it must see every page that still exists.
        configuration.syncMode === 'full_refresh'
          ? new AlwaysRevisit()
          : stream.revisit,
      );
      const crawl = crawler.crawl([inputUrl], previous.crawl, {
        signal: requestSignal,
        include: stream.include,
      });
      const errors: Error[] = [];
      // Pages that are not due: the scan keeps their records unread.
      const kept: KeptGroup[] = [];
      let savedAt = performance.now();
      const checkpoint = () => {
        savedAt = performance.now();
        return { diff, crawl: crawl.snapshot() };
      };
      for await (const entry of crawl) {
        if ('deferred' in entry) {
          kept.push({ key: entry.deferred.url, kept: true });
          continue;
        }
        if ('progress' in entry) {
          // Listings and archives hand out no pages, so their progress is saved on an interval.
          if (performance.now() - savedAt >= 1_000)
            yield {
              type: 'STATE',
              stream: configuration.stream.name,
              state: checkpoint(),
            };
          continue;
        }
        if ('error' in entry) {
          errors.push(entry.error);
          yield {
            type: 'STATE',
            stream: configuration.stream.name,
            state: checkpoint(),
          };
          continue;
        }
        try {
          const output = await run
            .read(entry.response, requestSignal)
            .catch(pageFailure);
          for await (const message of diffGroupedSnapshot(
            configuration,
            [
              {
                key: entry.url,
                fingerprint:
                  output.fingerprint === null
                    ? null
                    : hash(
                        'sha256',
                        JSON.stringify([
                          output.fingerprint,
                          entry.listingUrl,
                          entry.lastModified,
                          entry.published,
                        ]),
                      ),
                async *records() {
                  const records = await output.records().catch(pageFailure);
                  yield* validateRecords(
                    configuration.stream,
                    records.map((record) => ({
                      ...record,
                      inputUrl,
                      pageUrl: entry.url,
                      listingUrl: entry.listingUrl,
                      lastModified: entry.lastModified,
                      published: entry.published,
                    })),
                    'Web',
                  );
                },
              },
            ],
            diff,
            { continues: true, signal },
          )) {
            if ('type' in message && message.type === 'STATE') {
              diff = message.state;
              yield { ...message, state: checkpoint() };
            } else yield message;
          }
        } catch (error) {
          requestSignal.throwIfAborted();
          if (!(error instanceof PageFailure)) throw error;
          errors.push(error.failure);
          crawl.fail(entry.url);
          yield {
            type: 'STATE',
            stream: configuration.stream.name,
            state: checkpoint(),
          };
        }
      }
      requestSignal.throwIfAborted();
      // A crawl that a blocked host left unfinished has not reached every
      // group, so the scan goes on in the next run rather than ending here.
      if (crawl.snapshot().crawl !== null)
        yield {
          type: 'STATE',
          stream: configuration.stream.name,
          state: checkpoint(),
        };
      else
        for await (const message of diffGroupedSnapshot(
          configuration,
          kept,
          diff,
          {
            signal,
          },
        ))
          if ('type' in message && message.type === 'STATE')
            yield {
              ...message,
              state: { diff: message.state, crawl: crawl.snapshot() },
            };
          else yield message;
      due = crawl.nextDue();
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          errors.map((error) => error.message).join('; '),
        );
    } finally {
      const { name } = configuration.stream;
      const streamDue = this.#due.get(name) ?? new Map<string, number | null>();
      streamDue.set(inputUrl, due);
      this.#due.set(name, streamDue);
      const { resolve } = this.#extracted;
      this.#extracted = Promise.withResolvers();
      resolve();
    }
  }
}
