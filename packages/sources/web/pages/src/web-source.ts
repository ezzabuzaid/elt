import { hash } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

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
import { AlwaysRevisit, WebCrawler } from '@workspace/sdk-web-crawler';

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

export class WebSource extends Source {
  readonly identity = 'web-pages';
  protected readonly catalog: Catalog;
  readonly #stream: WebStream;
  readonly #inputs: readonly string[];
  // Each input's earliest due URL, as its last crawl left it; null when its crawl failed or nothing is ever due.
  readonly #due = new Map<string, number | null>();
  #extracted = Promise.withResolvers<void>();
  constructor(options: { stream: WebStream; inputs: readonly string[] }) {
    super();
    this.#stream = options.stream;
    this.#inputs = z
      .array(z.url({ protocol: /^https?$/ }))
      .min(1)
      .parse(options.inputs);
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
  // The source checks again when its earliest known URL is due, as each
  // input's last crawl left it. The watch runs a crawl beside this loop, so
  // the loop waits until every input's crawl since the last check has ended.
  protected async *observe({
    streams,
    signal,
  }: SourceWatchOptions): AsyncGenerator<readonly Stream[]> {
    yield streams;
    for (;;) {
      const extracted = this.#extracted.promise;
      const next =
        this.#due.size < this.#inputs.length
          ? Infinity
          : Math.min(...[...this.#due.values()].map((due) => due ?? Infinity));
      if (next > Date.now()) {
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
      this.#due.clear();
      yield streams;
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
    let due: number | null = null;
    try {
      const previous =
        state === null ? { diff: null, crawl: null } : saved.parse(state);
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
        // A full refresh replaces the collection, so it must see every page that still exists.
        configuration.syncMode === 'full_refresh'
          ? new AlwaysRevisit()
          : this.#stream.revisit,
      );
      const crawl = crawler.crawl([inputUrl], previous.crawl, {
        signal: requestSignal,
        include: this.#stream.include,
      });
      const errors: Error[] = [];
      let savedAt = performance.now();
      const checkpoint = () => {
        savedAt = performance.now();
        return { diff, crawl: crawl.snapshot() };
      };
      for await (const entry of crawl) {
        // A page that is not due keeps its row; the diff forgets its fingerprint, so it is extracted again when due (#3011).
        if ('deferred' in entry) continue;
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
      for await (const message of diffGroupedSnapshot(configuration, [], diff, {
        signal,
      }))
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
      this.#due.set(inputUrl, due);
      const { resolve } = this.#extracted;
      this.#extracted = Promise.withResolvers();
      resolve();
    }
  }
}
