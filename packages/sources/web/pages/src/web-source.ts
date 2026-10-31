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
import { routeRecords, routesState, routesStream } from './routes-stream.ts';
import { WebScan, outbox } from './web-scan.ts';
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
  outbox,
});

// A partitioned stream's saved state, as elt's PartitionState gives each
// partition's state; null before the stream committed any partition.
const partitionStates = z
  .object({
    partitions: z.array(
      z.object({
        partition: z.object({ inputUrl: z.string() }),
        state: routesState,
      }),
    ),
  })
  .nullable();

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

// A web stream's routes stream is named from it, as Airbyte names a child
// stream from its parent, such as source-github's teams and team_members.
function routesName(stream: WebStream) {
  return `${stream.name}_routes`;
}

const inputUrls = z.array(z.url({ protocol: /^https?$/ })).min(1);

/** A web stream without a usable input: none, or a URL that is not http or https. The user chooses the inputs, so only the user can fix it. */
export class InputError extends Error {}

export class WebSource extends Source<WebScan> {
  readonly identity = 'web-pages';
  protected readonly catalog: Catalog;
  // Each stream's web stream and the inputs that it crawls, by stream name.
  readonly #streams: ReadonlyMap<
    string,
    { readonly stream: WebStream; readonly inputs: readonly string[] }
  >;
  // Each routes stream's web stream and its inputs, by the routes stream's name.
  readonly #routes: ReadonlyMap<
    string,
    { readonly stream: WebStream; readonly inputs: readonly string[] }
  >;
  // Where the HTTP cache lives is the host's decision, like a destination's path.
  readonly #cachePath: string;
  // An optional crawler name selected by the host. Without one, requests
  // omit User-Agent and the crawler follows the default robots.txt group.
  readonly #userAgent: string | undefined;
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
    userAgent?: string;
  }) {
    super();
    this.#cachePath = z.string().min(1).parse(options.cachePath);
    this.#userAgent = z.string().min(1).optional().parse(options.userAgent);
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
    this.catalog = new Catalog([
      ...streams.map(({ stream }) => {
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
      ...streams.map(({ stream }) => routesStream(routesName(stream))),
    ]);
    this.#streams = new Map(streams.map((entry) => [entry.stream.name, entry]));
    this.#routes = new Map(
      streams.map((entry) => [routesName(entry.stream), entry]),
    );
  }
  #entry({ name }: Stream) {
    const entry = this.#streams.get(name) ?? this.#routes.get(name);
    if (entry === undefined)
      throw new TypeError(`Stream ${name} is not a stream of this source`);
    return entry;
  }
  coverage(stream: Stream) {
    const {
      stream: { include },
      inputs,
    } = this.#entry(stream);
    return {
      description: this.#routes.has(stream.name)
        ? 'Each URL in the scope of the crawls of chosen websites and feeds that a listing named, as the listings read; a listing that is read again completely replaces its rows.'
        : 'Records extracted from the pages crawled from chosen websites and feeds that match the configured URL patterns; listing disappearance does not imply deletion.',
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
  // Each routes stream's state says which groups of routes it committed, so
  // the web stream's crawl leaves them out of its outbox and numbers new
  // ones after them.
  protected async open(
    streams: readonly Stream[],
    _signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
  ) {
    const routed: string[] = [];
    const undelivered = new Map<string, number>();
    for (const { name } of streams) {
      const entry = this.#routes.get(name);
      if (entry === undefined) continue;
      routed.push(entry.stream.name);
      // Source.read reads a state that is not there as null too.
      const saved = partitionStates.parse((await states.get(name)) ?? null);
      if (saved !== null)
        for (const { partition, state } of saved.partitions)
          undelivered.set(
            `${entry.stream.name}\0${partition.inputUrl}`,
            state.undelivered,
          );
    }
    return new WebScan(routed, undelivered);
  }
  // A routes stream takes what the crawls of its web stream found in the
  // same read, and a read reads its streams in the order given, so every web
  // stream reads before every routes stream.
  override read(
    catalog: readonly CopyConfiguration[],
    states: { get(stream: string): unknown },
    signal?: AbortSignal,
  ) {
    return super.read(
      catalog.toSorted(
        (left, right) =>
          Number(this.#routes.has(left.stream.name)) -
          Number(this.#routes.has(right.stream.name)),
      ),
      states,
      signal,
    );
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
    // A routes stream is due with its web stream.
    const dueAt = (stream: Stream) => {
      const due = this.#due.get(this.#entry(stream).stream.name);
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
      for (const stream of due)
        this.#due.delete(this.#entry(stream).stream.name);
      yield due;
    }
  }
  protected async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    scan: WebScan,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const inputUrl = z.string().parse(partition?.inputUrl);
    const { stream } = this.#entry(configuration.stream);
    if (this.#routes.has(configuration.stream.name)) {
      // The routes of a crawl that did not run in this read stay as they are.
      const groups = scan.take(stream.name, inputUrl);
      if (groups !== undefined)
        yield* routeRecords(configuration, state, inputUrl, groups, signal);
      return;
    }
    let due: number | null = null;
    try {
      const previous =
        state === null
          ? { diff: null, crawl: null, outbox: [] }
          : saved.parse(state);
      let diff: unknown = previous.diff;
      // A read without the routes stream keeps the outbox as it is, and adds
      // nothing. A read with it leaves out the groups that the routes stream
      // committed, and numbers new groups after every group it knows, so a
      // web stream that starts over never reuses a committed number.
      const routed = scan.routed(stream.name);
      const undelivered = scan.undelivered(stream.name, inputUrl);
      const routes = routed
        ? previous.outbox.filter(({ seq }) => seq >= undelivered)
        : previous.outbox;
      let next = routes.reduce(
        (after, { seq }) => Math.max(after, seq + 1),
        undelivered,
      );
      if (routed) scan.offer(stream.name, inputUrl, routes);
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
        expand: stream.expand,
      });
      const errors: Error[] = [];
      // Pages that are not due: the scan keeps their records unread.
      const kept: KeptGroup[] = [];
      let savedAt = performance.now();
      const checkpoint = () => {
        savedAt = performance.now();
        return { diff, crawl: crawl.snapshot(), outbox: routes };
      };
      for await (const entry of crawl) {
        if ('deferred' in entry) {
          kept.push({ key: entry.deferred.url, kept: true });
          continue;
        }
        if ('routes' in entry && routed)
          for (const group of entry.routes)
            routes.push({ seq: next++, ...group });
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
              state: {
                diff: message.state,
                crawl: crawl.snapshot(),
                outbox: routes,
              },
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
