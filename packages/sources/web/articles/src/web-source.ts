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
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';
import { WebArticle } from '@workspace/sdk-web-article';
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

const saved = z.object({ after: z.string().nullable(), diff: z.unknown() });

export class WebSource extends Source {
  readonly identity = 'web-articles';
  protected readonly catalog = catalog;
  readonly #inputs: readonly string[];
  readonly #pollIntervalMs: number;
  readonly #include: readonly URLPattern[] | undefined;
  readonly #patterns: readonly string[] | undefined;
  constructor(options: {
    inputs: readonly string[];
    pollIntervalMs: number;
    include?: readonly string[];
  }) {
    super();
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
      state === null ? { after: null, diff: null } : saved.parse(state);
    let diff: unknown = previous.diff;
    // Source.read allows runs without a signal; the SDK requires a signal.
    const requestSignal = signal ?? new AbortController().signal;
    const pages = await new WebDiscovery().discover(inputUrl, requestSignal);
    const reader = new WebArticle();
    for (const page of pages.toSorted((a, b) =>
      a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
    )) {
      if (
        this.#include !== undefined &&
        !this.#include.some((pattern) => pattern.test(page.url))
      )
        continue;
      if (previous.after !== null && page.url <= previous.after) continue;
      const article = await reader.fetch(page.url, requestSignal);
      for await (const message of diffSnapshot(
        configuration,
        validateRecords(
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
        ),
        diff,
        { continues: true, signal },
      )) {
        if ('type' in message && message.type === 'STATE') {
          diff = message.state;
          yield { ...message, state: { after: page.url, diff } };
        } else yield message;
      }
    }
    for await (const message of diffSnapshot(configuration, [], diff, {
      signal,
    }))
      if ('type' in message && message.type === 'STATE')
        yield { ...message, state: { after: null, diff: message.state } };
      else yield message;
  }
}
