import { hash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setInterval } from 'node:timers/promises';

import KeyvSqlite from '@keyv/sqlite';
import got from 'got';
import { Keyv } from 'keyv';
import { pMapIterable } from 'p-map';
import PQueue from 'p-queue';
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
import {
  ArticleError,
  HTMLExtraction,
  MarkdownExtraction,
  WebArticle,
} from '@workspace/sdk-web-article';
import { WebDiscovery } from '@workspace/sdk-web-discovery';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
const properties = {
  inputUrl: {
    ...text,
    description: 'The chosen website, sitemap or feed; the partition key.',
  },
  pageUrl: {
    ...text,
    description:
      'Discovered page URL, preserving queries and trailing slashes; the article key within this input.',
  },
  listingUrl: {
    ...text,
    description: 'The listing that first supplied the page URL.',
  },
  lastModified: {
    ...nullableText,
    description:
      'Raw sitemap modification hint, not a change cursor or publication date.',
  },
  url: { ...text, description: 'Final HTTP response URL after redirects.' },
  canonicalUrl: {
    ...nullableText,
    description: 'Declared HTTP(S) canonical URL, not used to merge records.',
  },
  title: { ...nullableText, description: 'Extracted article title.' },
  byline: {
    ...nullableText,
    description: 'Author metadata as supplied by the page.',
  },
  publishedTime: {
    ...nullableText,
    description:
      'Publication metadata as supplied, without date inference or conversion.',
  },
  content: { ...text, description: 'Sanitized article HTML.' },
  markdown: {
    ...text,
    description:
      'Native Markdown body when available, otherwise converted from sanitized article HTML.',
  },
  textContent: {
    ...text,
    description: 'Readable article text, with paragraph and table structure.',
  },
  length: {
    type: 'integer',
    minimum: 0,
    description: 'Length of textContent in JavaScript string units.',
  },
  excerpt: {
    ...nullableText,
    description: 'Extracted description or first-paragraph excerpt.',
  },
  siteName: { ...nullableText, description: 'Publisher metadata.' },
  lang: { ...nullableText, description: 'Declared content language.' },
  dir: { ...nullableText, description: 'Declared content direction.' },
} as const;

const catalog = new Catalog([
  new Stream({
    name: 'articles',
    jsonSchema: {
      type: 'object',
      description:
        'One readable article per chosen input and discovered URL. Incremental scans retain articles absent from later listings.',
      properties,
      required: Object.keys(properties),
    },
    primaryKey: ['inputUrl', 'pageUrl'],
    partitionKey: ['inputUrl'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  }),
]);

const saved = z.object({
  after: z.string().nullable(),
  diff: z.unknown(),
  failed: z.array(
    z.object({
      url: z.url({ protocol: /^https?$/ }),
      listingUrl: z.url({ protocol: /^https?$/ }),
      lastModified: z.string().nullable(),
    }),
  ),
});

export class WebSource extends Source {
  readonly identity = 'web-articles';
  protected readonly catalog = catalog;
  readonly #inputs: readonly string[];
  readonly #pollIntervalMs: number;
  readonly #include: readonly URLPattern[] | undefined;
  readonly #patterns: readonly string[] | undefined;
  readonly #cachePath: string;
  constructor(options: {
    inputs: readonly string[];
    pollIntervalMs: number;
    cachePath: string;
    include?: readonly string[];
  }) {
    super();
    this.#cachePath = resolve(
      z
        .string()
        .min(1)
        .refine(
          (path) => path !== ':memory:' && !path.includes('\0'),
          'HTTP cache requires a persistent file path',
        )
        .parse(options.cachePath),
    );
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
    this.#patterns = options.include?.slice();
    this.#include = this.#patterns?.map((pattern) => new URLPattern(pattern));
  }
  coverage() {
    return {
      description:
        'Articles from chosen websites and feeds matching the configured URL patterns; listing disappearance does not imply deletion.',
      selection: {
        inputs: this.#inputs,
        ...(this.#patterns === undefined ? {} : { include: this.#patterns }),
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
        ? { after: null, diff: null, failed: [] }
        : saved.parse(state);
    let diff: unknown = previous.diff;
    let after = previous.after;
    const failed = new Map(previous.failed.map((page) => [page.url, page]));
    await using resources = new AsyncDisposableStack();
    await using file = await open(this.#cachePath, 'a', 0o600);
    await file.chmod(0o600);
    const cache = new Keyv<unknown>({
      store: new KeyvSqlite({
        uri: `sqlite://${this.#cachePath}`,
        driver: 'node:sqlite',
        busyTimeout: 30_000,
      }),
    });
    resources.defer(() => cache.disconnect());
    const errors: ArticleError[] = [];
    const stop = new AbortController();
    const onCacheError = (error: unknown) => stop.abort(error);
    cache.on('error', onCacheError);
    const requestSignal =
      signal === undefined
        ? stop.signal
        : AbortSignal.any([signal, stop.signal]);
    const starts = new PQueue({
      intervalCap: 2,
      interval: 1_000,
      strict: true,
    });
    try {
      const http = got.extend({
        cache,
        headers: { 'cache-control': 'no-cache' },
        timeout: { request: 30_000 },
        hooks: {
          beforeRequest: [
            () => starts.add(() => undefined, { signal: requestSignal }),
          ],
        },
      });
      const pages = await new WebDiscovery(http).discover(
        inputUrl,
        requestSignal,
      );
      const reader = new WebArticle(
        [new MarkdownExtraction(), new HTMLExtraction()],
        http,
      );
      const pendingPages = [
        ...new Map(
          [...previous.failed, ...pages].map((page) => [page.url, page]),
        ).values(),
      ]
        .toSorted((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
        .filter(
          (page) =>
            (this.#include === undefined ||
              this.#include.some((pattern) => pattern.test(page.url))) &&
            (previous.after === null ||
              page.url > previous.after ||
              failed.has(page.url)),
        );
      for await (const result of pMapIterable(
        pendingPages,
        async (page) => {
          try {
            return {
              page,
              download: await reader.download(page.url, requestSignal),
            };
          } catch (error) {
            requestSignal.throwIfAborted();
            if (!(error instanceof ArticleError)) throw error;
            return { page, error };
          }
        },
        { concurrency: 4 },
      )) {
        const { page } = result;
        if (after === null || page.url > after) after = page.url;
        try {
          if (result.error) throw result.error;
          const { download } = result;
          for await (const message of diffGroupedSnapshot(
            configuration,
            [
              {
                key: page.url,
                fingerprint:
                  download.fingerprint === null
                    ? null
                    : hash(
                        'sha256',
                        JSON.stringify([
                          download.fingerprint,
                          page.listingUrl,
                          page.lastModified,
                        ]),
                      ),
                async *records() {
                  const article = await download.extract();
                  yield* validateRecords(
                    configuration.stream,
                    article === null
                      ? []
                      : [
                          {
                            ...article,
                            inputUrl,
                            pageUrl: page.url,
                            listingUrl: page.listingUrl,
                            lastModified: page.lastModified,
                            // Readability's public result permits undefined metadata; stream cells use null.
                            title: article.title ?? null,
                            byline: article.byline ?? null,
                            publishedTime: article.publishedTime ?? null,
                            excerpt: article.excerpt ?? null,
                            siteName: article.siteName ?? null,
                            lang: article.lang ?? null,
                            dir: article.dir ?? null,
                          },
                        ],
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
              failed.delete(page.url);
              yield {
                ...message,
                state: { after, diff, failed: [...failed.values()] },
              };
            } else yield message;
          }
        } catch (error) {
          requestSignal.throwIfAborted();
          if (!(error instanceof ArticleError)) throw error;
          failed.set(page.url, page);
          errors.push(error);
          yield {
            type: 'STATE',
            stream: configuration.stream.name,
            state: { after, diff, failed: [...failed.values()] },
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
              after: null,
              diff: message.state,
              failed: [...failed.values()],
            },
          };
        else yield message;
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          errors.map((error) => error.message).join('; '),
        );
    } finally {
      stop.abort();
      await starts.onIdle();
      cache.off('error', onCacheError);
    }
  }
}
