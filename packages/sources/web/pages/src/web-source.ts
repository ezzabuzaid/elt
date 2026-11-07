import { hash } from 'node:crypto';

import { z } from 'zod';

import {
  Catalog,
  type CopyConfiguration,
  type KeptGroup,
  type Partition,
  type PipelineClock,
  Source,
  type SourceMessage,
  type SourceReadOptions,
  Stream,
  diffGroupedSnapshot,
  validateRecords,
} from '@workspace/elt';
import { AlwaysRevisit } from '@workspace/sdk-web-crawler';

import { crawlRecords, crawlsStream } from './crawls-stream.ts';
import { DueTime } from './due-time.ts';
import { failureRecords, failuresStream } from './failures-stream.ts';
import { WebClient } from './http/web-http.ts';
import { PageExtracted, pageChannels } from './page-channels.ts';
import { routeRecords, routesState, routesStream } from './routes-stream.ts';
import { WebRead } from './web-read.ts';
import { type CrawlEnd, type Outbox, WebScan, outbox } from './web-scan.ts';
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
  listedVersions: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          description: 'The language code, such as en or de-de, in lower case.',
        },
        url: { type: 'string', description: 'The URL of the copy.' },
      },
      required: ['language', 'url'],
    },
    description:
      "The language copies that the listing declares for the page, such as a sitemap's xhtml:link hreflang elements; empty when it declares none. Not the page's own declaration.",
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

// A web stream's crawls stream, named from it as its routes stream is.
function crawlsName(stream: WebStream) {
  return `${stream.name}_crawls`;
}

// A web stream's failures stream, its dead-letter output, named as its routes stream is.
function failuresName(stream: WebStream) {
  return `${stream.name}_failures`;
}

// How often a watch checks whether a stream is due. A due stream is read at
// most one interval late.
const checkIntervalMs = 1000;

const inputUrls = z.array(z.url({ protocol: /^https?$/ })).min(1);

/** A web stream without a usable input: none, or a URL that is not http or https. The user chooses the inputs, so only the user can fix it. */
export class InputError extends Error {}

export class WebSource extends Source<WebRead> {
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
  // Each crawls stream's web stream and its inputs, by the crawls stream's name.
  readonly #crawls: ReadonlyMap<
    string,
    { readonly stream: WebStream; readonly inputs: readonly string[] }
  >;
  // Each failures stream's web stream and its inputs, by the failures stream's name.
  readonly #failures: ReadonlyMap<
    string,
    { readonly stream: WebStream; readonly inputs: readonly string[] }
  >;
  // Where the HTTP cache lives is the host's decision, like a destination's path.
  readonly #cachePath: string;
  // An optional crawler name selected by the host. Without one, requests
  // omit User-Agent and the crawler follows the default robots.txt group.
  readonly #userAgent: string | undefined;
  protected override readonly configErrors = [InputError];
  // A routes stream reads beside its web stream, so it loads the routes of
  // each checkpoint while the crawl goes on. Two web streams can crawl at
  // once: the origins' records space the requests to each origin.
  protected override readonly concurrency = 2;
  // Each input's earliest due URL by stream, as its last crawl left it, or
  // its starting URL's as a failed one after a read that failed; null when
  // nothing is ever due, or when the read stopped or failed before its crawl.
  readonly #due = new Map<string, Map<string, number | null>>();
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
      ...streams.map(({ stream }) => crawlsStream(crawlsName(stream))),
      ...streams.map(({ stream }) => failuresStream(failuresName(stream))),
    ]);
    this.#streams = new Map(streams.map((entry) => [entry.stream.name, entry]));
    this.#routes = new Map(
      streams.map((entry) => [routesName(entry.stream), entry]),
    );
    this.#crawls = new Map(
      streams.map((entry) => [crawlsName(entry.stream), entry]),
    );
    this.#failures = new Map(
      streams.map((entry) => [failuresName(entry.stream), entry]),
    );
  }
  #entry({ name }: Stream) {
    const entry =
      this.#streams.get(name) ??
      this.#routes.get(name) ??
      this.#crawls.get(name) ??
      this.#failures.get(name);
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
        : this.#crawls.has(stream.name)
          ? 'Whether the last crawl of each chosen website or feed is complete, and when the first crawl that gave that answer ended.'
          : this.#failures.has(stream.name)
            ? 'The pages of the crawls of chosen websites and feeds whose last visit failed, as the last crawl of each left them.'
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
  // ones after them. Every crawl of the read shares one client, and with it
  // the record of each origin.
  protected async open(
    streams: readonly Stream[],
    signal: AbortSignal | undefined,
    states: { get(stream: string): unknown },
    clock: PipelineClock,
  ) {
    const crawled = new Map(
      streams.flatMap(({ name }) => {
        const entry = this.#streams.get(name);
        return entry === undefined ? [] : [[name, entry.inputs] as const];
      }),
    );
    // A web stream that this read crawls is not due until each of its
    // inputs' crawls ended. Else a check between the ends of two crawls
    // reads a due time that the read already met, and wakes the stream again.
    for (const name of crawled.keys()) this.#due.delete(name);
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
    return new WebRead(
      new WebScan(crawled, routed, undelivered),
      await WebClient.open(this.#cachePath, this.#userAgent, signal, clock),
      clock,
    );
  }
  // A routes stream takes what the crawls of its web stream find in the same
  // read, and a crawls or failures stream how each crawl ended, and a read
  // reads two streams at a time in the order given, so each web stream reads
  // beside its routes stream, and its crawls and failures streams follow. A
  // routes, crawls or failures stream whose web stream the read does not
  // select reads last, and gives nothing.
  override read(
    catalog: readonly CopyConfiguration[],
    states: { get(stream: string): unknown },
    options: SourceReadOptions,
  ) {
    const ordered = catalog
      .filter(({ stream }) => this.#streams.has(stream.name))
      .flatMap((web) => [
        web,
        ...catalog.filter(
          ({ stream }) =>
            stream.name === routesName(this.#entry(web.stream).stream),
        ),
        ...catalog.filter(
          ({ stream }) =>
            stream.name === crawlsName(this.#entry(web.stream).stream),
        ),
        ...catalog.filter(
          ({ stream }) =>
            stream.name === failuresName(this.#entry(web.stream).stream),
        ),
      ]);
    return super.read(
      [...ordered, ...catalog.filter((entry) => !ordered.includes(entry))],
      states,
      options,
    );
  }
  protected override partitions(stream: Stream) {
    return this.#entry(stream).inputs.map((inputUrl) => ({ inputUrl }));
  }
  // Each web stream checks again when its earliest known URL is due, as its
  // inputs' last crawls left it, and only the streams that are due are read.
  // A routes, crawls or failures stream is due with its web stream.
  override changeSignals(streams: readonly Stream[]) {
    return Map.groupBy(streams, (stream) => this.#entry(stream))
      .entries()
      .map(([{ stream, inputs }, watched]) => ({
        gauge: new DueTime(() => {
          const due = this.#due.get(stream.name);
          return due === undefined || due.size < inputs.length
            ? Infinity
            : Math.min(...[...due.values()].map((at) => at ?? Infinity));
        }),
        streams: watched,
        interval: checkIntervalMs,
        // The read is of memory: a check that takes the whole interval is
        // stuck.
        timeout: checkIntervalMs,
      }));
  }
  protected async *extract(
    configuration: CopyConfiguration,
    state: unknown,
    partition: Partition | null,
    { scan, client, clock }: WebRead,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<SourceMessage> {
    const inputUrl = z.string().parse(partition?.inputUrl);
    const { stream } = this.#entry(configuration.stream);
    if (this.#routes.has(configuration.stream.name)) {
      // The routes of a crawl that did not run in this read stay as they are.
      let latest = state;
      for await (const groups of scan.take(stream.name, inputUrl, signal) ?? [])
        for await (const message of routeRecords(
          configuration,
          latest,
          inputUrl,
          groups,
          signal,
        )) {
          if ('type' in message && message.type === 'STATE')
            latest = message.state;
          yield message;
        }
      return;
    }
    if (this.#crawls.has(configuration.stream.name)) {
      // A crawl that did not run in this read keeps its row as it is.
      const crawl = await scan.ended(stream.name, inputUrl, signal);
      if (crawl !== undefined && crawl !== null)
        yield* crawlRecords(configuration, state, inputUrl, crawl);
      return;
    }
    if (this.#failures.has(configuration.stream.name)) {
      // A crawl that did not run in this read keeps its rows as they are.
      const crawl = await scan.ended(stream.name, inputUrl, signal);
      if (crawl !== undefined && crawl !== null)
        yield* failureRecords(
          configuration,
          state,
          inputUrl,
          crawl.failures,
          signal,
        );
      return;
    }
    let due: number | null = null;
    // How the crawl ended; null until it begins.
    let ended: CrawlEnd | null = null;
    // A full refresh that failed reads no later input.
    let stopping = false;
    // The groups that the routes stream was given so far.
    let given = 0;
    let routes: Outbox = [];
    const give = () => {
      scan.give(stream.name, inputUrl, routes.slice(given));
      given = routes.length;
    };
    // After each commit: the routes stream gets what the commit holds, and
    // the origins' records are saved, so a block or a slowdown outlives a
    // process that stops.
    const committed = async () => {
      give();
      await client.save();
    };
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
      routes = routed
        ? previous.outbox.filter(({ seq }) => seq >= undelivered)
        : previous.outbox;
      let next = routes.reduce(
        (after, { seq }) => Math.max(after, seq + 1),
        undelivered,
      );
      // Each group the web stream committed goes to the routes stream once
      // the commit ended, when its checkpoint's yield returns.
      give();
      const requestSignal = client.signal;
      const run = stream.extractor.open(client.http);
      const crawler = client.crawler(
        stream.readers,
        // A full refresh replaces the collection, so it must see every page that still exists.
        configuration.syncMode === 'full_refresh'
          ? new AlwaysRevisit()
          : stream.revisit,
        run.negotiation,
      );
      const crawl = crawler.crawl([inputUrl], previous.crawl, {
        signal: requestSignal,
        include: stream.include,
        expand: stream.expand,
      });
      // How the crawl ended, now.
      const end = (complete: boolean): CrawlEnd => ({
        complete,
        at: new Date(clock.Date.now()).toISOString(),
        failures: crawl.failures(),
      });
      const errors: Error[] = [];
      // Pages that are not due: the scan keeps their records unread.
      const kept: KeptGroup[] = [];
      let savedAt = clock.performance.now();
      const checkpoint = () => {
        savedAt = clock.performance.now();
        return { diff, crawl: crawl.snapshot(), outbox: routes };
      };
      try {
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
            if (clock.performance.now() - savedAt >= 1_000) {
              yield {
                type: 'STATE',
                stream: configuration.stream.name,
                state: checkpoint(),
              };
              await committed();
            }
            continue;
          }
          if ('error' in entry) {
            errors.push(entry.error);
            yield {
              type: 'STATE',
              stream: configuration.stream.name,
              state: checkpoint(),
            };
            await committed();
            continue;
          }
          try {
            const reading = clock.performance.now();
            const output = await run
              .read(entry.response, requestSignal)
              .catch(pageFailure);
            const read = clock.performance.now() - reading;
            let extracted: { records: number; duration: number } | null = null;
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
                            entry.localizedVersions,
                          ]),
                        ),
                  async *records() {
                    const extracting = clock.performance.now();
                    const records = await output.records().catch(pageFailure);
                    extracted = {
                      records: records.length,
                      duration: clock.performance.now() - extracting,
                    };
                    yield* validateRecords(
                      configuration.stream,
                      records.map((record) => ({
                        ...record,
                        inputUrl,
                        pageUrl: entry.url,
                        listingUrl: entry.listingUrl,
                        lastModified: entry.lastModified,
                        published: entry.published,
                        listedVersions: entry.localizedVersions,
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
                await committed();
              } else yield message;
            }
            pageChannels.extract.publish(
              new PageExtracted(
                crawl,
                configuration.stream.name,
                entry.url,
                read,
                extracted,
              ),
            );
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
            await committed();
          }
        }
        requestSignal.throwIfAborted();
        // A crawl that a blocked host left unfinished has not reached every
        // group, so the scan goes on in the next run rather than ending here.
        if (crawl.snapshot().crawl !== null) {
          yield {
            type: 'STATE',
            stream: configuration.stream.name,
            state: checkpoint(),
          };
          await committed();
        } else
          for await (const message of diffGroupedSnapshot(
            configuration,
            kept,
            diff,
            {
              signal,
            },
          ))
            if ('type' in message && message.type === 'STATE') {
              yield {
                ...message,
                state: {
                  diff: message.state,
                  crawl: crawl.snapshot(),
                  outbox: routes,
                },
              };
              await committed();
            } else yield message;
        ended = end(crawl.snapshot().crawl === null);
        due = crawl.nextDue();
      } catch (error) {
        // A read that failed for a reason that is not a page's, such as a
        // record that the schema rejects or a full disk, is due again when
        // its starting URL is as a failed one, so the watch reads it again
        // once the pipeline's retries end, as a schedule outlives a failed
        // sync.
        crawl.abandon();
        due = crawl.nextDue();
        ended = end(false);
        throw error;
      }
      if (errors.length > 0)
        throw new AggregateError(
          errors,
          errors.map((error) => error.message).join('; '),
        );
    } catch (error) {
      stopping = configuration.syncMode === 'full_refresh';
      throw error;
    } finally {
      // As before a failure: the routes stream also gets the groups found
      // since the last checkpoint, and the crawl's next run finds them again.
      give();
      scan.end(stream.name, inputUrl, ended);
      if (stopping) scan.stop(stream.name);
      const { name } = configuration.stream;
      const streamDue = this.#due.get(name) ?? new Map<string, number | null>();
      streamDue.set(inputUrl, due);
      this.#due.set(name, streamDue);
    }
  }
}
