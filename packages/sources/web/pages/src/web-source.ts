import { hash } from 'node:crypto';
import { setInterval } from 'node:timers/promises';

import { z } from 'zod';

import {
  Catalog,
  type CopyConfiguration,
  type Partition,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
  diffGroupedSnapshot,
  validateRecords,
} from '@workspace/elt';
import { type PageLocation, WebCrawler } from '@workspace/sdk-web-crawler';

import { webHttp } from './http/web-http.ts';
import type { WebStream } from './web-stream.ts';

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
      'Raw sitemap modification hint, not a change cursor or publication date.',
  },
} as const;

const location = z.object({
  url: z.url({ protocol: /^https?$/ }),
  listingUrl: z.url({ protocol: /^https?$/ }),
  lastModified: z.string().nullable(),
});

const saved = z.object({
  diff: z.unknown(),
  // The unfinished crawl's snapshot; null once a crawl finishes.
  crawl: z.unknown(),
  // Failed pages, handed to the next crawl so a page that leaves every listing is not lost.
  retry: z.array(location),
});

// A page that the stream's extractor could not read: recorded and retried, while the other pages continue.
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

export class WebSource extends Source {
  readonly identity = 'web-pages';
  protected readonly catalog: Catalog;
  readonly #stream: WebStream;
  readonly #inputs: readonly string[];
  readonly #pollIntervalMs: number;
  constructor(options: {
    stream: WebStream;
    inputs: readonly string[];
    pollIntervalMs: number;
  }) {
    super();
    this.#stream = options.stream;
    this.#inputs = z
      .array(z.url({ protocol: /^https?$/ }))
      .min(1)
      .parse(options.inputs);
    this.#pollIntervalMs = z
      .number()
      .int()
      .positive()
      .max(2 ** 31 - 1)
      .parse(options.pollIntervalMs);
    const properties = {
      ...provenance,
      ...options.stream.extractor.properties,
    };
    this.catalog = new Catalog([
      new Stream({
        name: options.stream.name,
        jsonSchema: {
          type: 'object',
          description:
            'Records extracted from the pages crawled for each chosen input. Incremental scans retain records absent from later listings.',
          properties,
          required: Object.keys(properties),
        },
        primaryKey: ['inputUrl', ...options.stream.primaryKey],
        partitionKey: ['inputUrl'],
        supportedSyncModes: ['full_refresh', 'incremental'],
        sourceDefinedCursor: true,
      }),
    ]);
  }
  coverage() {
    const { include } = this.#stream;
    return {
      description:
        'Records extracted from the pages crawled from chosen websites and feeds that match the configured URL patterns; listing disappearance does not imply deletion.',
      selection: {
        inputs: this.#inputs,
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
  protected override partitions() {
    return this.#inputs.map((inputUrl) => ({ inputUrl }));
  }
  protected async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    yield streams;
    for await (const selected of setInterval(this.#pollIntervalMs, streams, {
      signal,
    }))
      yield selected;
  }
  protected async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    _context: AsyncDisposable,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const inputUrl = z.string().parse(partition?.inputUrl);
    const previous =
      state === null
        ? { diff: null, crawl: null, retry: [] }
        : saved.parse(state);
    let diff: unknown = previous.diff;
    await using client = await webHttp(signal);
    const { http, signal: requestSignal } = client;
    const run = this.#stream.extractor.open(http);
    const crawler = new WebCrawler(
      http.extend({
        hooks: {
          beforeRequest: [
            (options) => {
              if (options.context.page === true && run.accept !== null)
                options.headers.accept = run.accept;
            },
          ],
        },
      }),
      this.#stream.readers,
    );
    // Every run, fresh or resumed, tries the saved failures again and collects its own.
    const options = {
      signal: requestSignal,
      include: this.#stream.include,
      pages: previous.retry,
    };
    const crawl =
      previous.crawl === null
        ? crawler.run([inputUrl], options)
        : crawler.resume(previous.crawl, options);
    const retry = new Map<string, PageLocation>();
    const errors: Error[] = [];
    let savedAt = performance.now();
    const checkpoint = () => {
      savedAt = performance.now();
      return { diff, crawl: crawl.snapshot(), retry: [...retry.values()] };
    };
    for await (const entry of crawl) {
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
      const page = {
        url: entry.url,
        listingUrl: entry.listingUrl,
        lastModified: entry.lastModified,
      };
      if ('error' in entry) {
        errors.push(entry.error);
        // A failed listing returns with the next crawl; only pages need keeping.
        if (entry.page) retry.set(page.url, page);
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
              key: page.url,
              fingerprint:
                output.fingerprint === null
                  ? null
                  : hash(
                      'sha256',
                      JSON.stringify([
                        output.fingerprint,
                        page.listingUrl,
                        page.lastModified,
                      ]),
                    ),
              async *records() {
                const records = await output.records().catch(pageFailure);
                yield* validateRecords(
                  configuration.stream,
                  records.map((record) => ({
                    ...record,
                    inputUrl,
                    pageUrl: page.url,
                    listingUrl: page.listingUrl,
                    lastModified: page.lastModified,
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
        retry.set(page.url, page);
        yield {
          type: 'STATE',
          stream: configuration.stream.name,
          state: checkpoint(),
        };
      }
    }
    requestSignal.throwIfAborted();
    for await (const message of diffGroupedSnapshot(configuration, [], diff, {
      signal,
    }))
      if ('type' in message && message.type === 'STATE')
        yield {
          ...message,
          state: {
            diff: message.state,
            crawl: null,
            retry: [...retry.values()],
          },
        };
      else yield message;
    if (errors.length > 0)
      throw new AggregateError(
        errors,
        errors.map((error) => error.message).join('; '),
      );
  }
}
