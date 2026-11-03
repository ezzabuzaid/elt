import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';

import { SeverityNumber, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { TemporaryFiles } from '@zukhruf/testing/fs';
import { HttpServer } from '@zukhruf/testing/http';
import { Sqlite } from '@zukhruf/testing/sqlite';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  AlwaysRevisit,
  CrawlHandedOff,
  ListingReader,
  crawlChannels,
} from '@workspace/sdk-web-crawler';
import { ArticleExtractor } from '@workspace/source-web-pages/article-extractor';
import {
  PageExtracted,
  pageChannels,
} from '@workspace/source-web-pages/page-channels';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import { EltInstrumentation } from './elt-instrumentation.ts';

// The SDK that a host installs, with in-memory exporters in place of OTLP,
// as OpenTelemetry's own tests read what an instrumentation made.
// registerInstrumentations is what NodeSDK.start calls.
function install() {
  const spans = new InMemorySpanExporter();
  const tracerProvider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  });
  const points = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // Read on demand only: the interval never passes in a test.
  const reader = new PeriodicExportingMetricReader({
    exporter: points,
    exportIntervalMillis: 3_600_000,
  });
  const meterProvider = new MeterProvider({ readers: [reader] });
  const records = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: records })],
  });
  const instrumentation = new EltInstrumentation(globalThis);
  const unregister = registerInstrumentations({
    instrumentations: [instrumentation],
    tracerProvider,
    meterProvider,
    loggerProvider,
  });
  return {
    instrumentation,
    spans: () => spans.getFinishedSpans(),
    // The metrics as the reader collects them now.
    metrics: async () => {
      await reader.forceFlush();
      return (
        points
          .getMetrics()
          .at(-1)
          ?.scopeMetrics.flatMap((scope) => scope.metrics) ?? []
      );
    },
    records: () => records.getFinishedLogRecords(),
    async [Symbol.asyncDispose]() {
      unregister();
      await Promise.all([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}

// A site of one feed that lists its articles; respond answers each request
// that is not the feed's.
function site(
  articles: readonly string[],
  respond: (path: string, response: ServerResponse) => void | Promise<void> = (
    path,
    response,
  ) => {
    response.writeHead(200, { 'content-type': 'text/html' }).end(article(path));
  },
) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? '/';
    if (path === '/robots.txt') response.writeHead(404).end();
    else if (path === '/feed.xml')
      response
        .writeHead(200, { 'content-type': 'application/rss+xml' })
        .end(
          `<rss><channel>${articles.map((link) => `<item><link>${link}</link></item>`).join('')}</channel></rss>`,
        );
    else await respond(path, response);
  };
}

function article(path: string) {
  return `<html><body><article><h1>Report ${path}</h1><p>Read the findings of ${path} in the field.</p></article></body></html>`;
}

function articles(name = 'articles') {
  return new WebStream({
    name,
    primaryKey: ['articleUrl'],
    readers: [new ListingReader()],
    extractor: new ArticleExtractor(),
  });
}

// A connection that copies the named web streams of a source into a SQLite
// file of its own, as logful copies its one web stream.
async function connection(
  name: string,
  source: WebSource,
  streams: readonly string[],
  database: string,
  checkpoints: string,
) {
  const destination = new SQLiteDestination({ path: database });
  const catalog = await source.discover();
  return new Connection({
    name,
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({ path: checkpoints }),
    steps: streams.map(
      (stream) =>
        new Copy(catalog.get(stream), destination.table(stream), {
          id: `${name}:${stream}`,
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
    ),
  });
}

// Holds each caller until count callers wait: a crawl that reaches it is
// held until the others are in flight too.
function barrier(count: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  let waiting = 0;
  return () => {
    waiting++;
    if (waiting === count) resolve();
    return promise;
  };
}

// Rows in one order, whatever order the SDK gave them in.
function sorted<Row>(rows: readonly Row[]) {
  return rows.toSorted((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

// Each metric's points as a dashboard reads them: attributes and value.
function values(metrics: readonly MetricData[]) {
  return metrics.map(({ descriptor, dataPoints }) => [
    descriptor.name,
    dataPoints.map(({ attributes, value }) => [attributes, value]),
  ]);
}

function named(spans: readonly ReadableSpan[], name: string) {
  return spans.filter((span) => span.name === name);
}

function parentOf(span: ReadableSpan, spans: readonly ReadableSpan[]) {
  return spans.find(
    (candidate) =>
      candidate.spanContext().spanId === span.parentSpanContext?.spanId,
  );
}

test("each crawl's span is a child of its own pass's span when two passes run at once", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // Each site holds its article's request until the other site's crawl asks
  // for its own, so both passes are in flight at once.
  const both = barrier(2);
  const hold = async (path: string, response: ServerResponse) => {
    await both();
    response.writeHead(200, { 'content-type': 'text/html' }).end(article(path));
  };
  await using north = await new HttpServer().start(site(['/report'], hold));
  await using south = await new HttpServer().start(site(['/report'], hold));
  await using northData = await new Sqlite().database();
  await using northCheckpoints = await new Sqlite().database();
  await using southData = await new Sqlite().database();
  await using southCheckpoints = await new Sqlite().database();
  const source = (origin: string, file: string) =>
    new WebSource({
      cachePath: join(cache.path, file),
      streams: [{ stream: articles(), inputs: [`${origin}/feed.xml`] }],
    });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'north',
        source(north.origin, 'north.sqlite'),
        ['articles'],
        northData.path,
        northCheckpoints.path,
      ),
      await connection(
        'south',
        source(south.origin, 'south.sqlite'),
        ['articles'],
        southData.path,
        southCheckpoints.path,
      ),
    ],
  });

  await pipeline.run();

  const spans = telemetry.spans();
  const crawls = named(spans, 'elt.crawl');
  assert.equal(crawls.length, 2);
  assert.deepEqual(
    crawls
      .map((crawl) => [
        new URL(String(crawl.attributes['elt.crawl.starts'])).origin,
        parentOf(crawl, spans)?.name,
        parentOf(crawl, spans)?.attributes['elt.connection'],
      ])
      .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
    [
      [north.origin, 'elt.pass', 'north'],
      [south.origin, 'elt.pass', 'south'],
    ].toSorted(([a], [b]) => String(a).localeCompare(String(b))),
  );
});

test("each request's and each extraction's span is a child of its own crawl's span when two crawls run at once", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // The source reads two streams at once; each site holds its article's
  // request until the other stream's crawl asks for its own.
  const both = barrier(2);
  const hold = async (path: string, response: ServerResponse) => {
    await both();
    response.writeHead(200, { 'content-type': 'text/html' }).end(article(path));
  };
  await using north = await new HttpServer().start(site(['/report'], hold));
  await using south = await new HttpServer().start(site(['/report'], hold));
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    streams: [
      { stream: articles('north'), inputs: [`${north.origin}/feed.xml`] },
      { stream: articles('south'), inputs: [`${south.origin}/feed.xml`] },
    ],
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        source,
        ['north', 'south'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  await pipeline.run();

  const spans = telemetry.spans();
  const requests = named(spans, 'elt.crawl.request');
  const extractions = named(spans, 'elt.web.extract');
  // Each site's feed and article, and each article's records.
  assert.deepEqual(
    requests.map(({ attributes }) => attributes['url.full']).toSorted(),
    [
      `${north.origin}/feed.xml`,
      `${north.origin}/report`,
      `${south.origin}/feed.xml`,
      `${south.origin}/report`,
    ].toSorted(),
  );
  assert.deepEqual(
    extractions.map(({ attributes }) => attributes['url.full']).toSorted(),
    [`${north.origin}/report`, `${south.origin}/report`].toSorted(),
  );
  for (const span of [...requests, ...extractions]) {
    const crawl = parentOf(span, spans);
    assert.equal(crawl?.name, 'elt.crawl');
    assert.equal(
      new URL(String(crawl.attributes['elt.crawl.starts'])).origin,
      new URL(String(span.attributes['url.full'])).origin,
    );
  }
});

test('a request that gets no answer is an error span, a warning and a request counted by its error', async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // The site drops the connection of its article's request, each time Got
  // asks again.
  await using upstream = await new HttpServer().start(
    site(['/report'], (_path, response) => {
      response.socket?.destroy();
    }),
  );
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });
  const report = `${upstream.origin}/report`;

  await assert.rejects(
    pipeline.run(),
    /could not read .*\/report: socket hang up/,
  );

  const [pass] = named(telemetry.spans(), 'elt.pass');
  assert.deepEqual(pass?.status, {
    code: SpanStatusCode.ERROR,
    message: 'web:articles did not load completely',
  });
  const failed = named(telemetry.spans(), 'elt.crawl.request').find(
    ({ attributes }) => attributes['url.full'] === report,
  );
  assert.equal(failed?.status.code, SpanStatusCode.ERROR);
  assert.equal(failed.attributes['error.type'], 'ECONNRESET');
  assert.deepEqual(
    telemetry
      .records()
      .filter(({ severityText }) => severityText === 'WARN')
      .map(({ severityNumber, attributes }) => [
        severityNumber,
        attributes['url.full'],
        attributes['error.type'],
      ]),
    [[SeverityNumber.WARN, report, 'ECONNRESET']],
  );
  const requests = (await telemetry.metrics()).find(
    ({ descriptor }) => descriptor.name === 'elt.crawl.requests',
  );
  assert.deepEqual(
    requests?.dataPoints
      .filter(({ attributes }) => 'error.type' in attributes)
      .map(({ attributes, value }) => [attributes, value]),
    [
      [
        {
          'elt.origin': upstream.origin,
          'elt.crawl.lane': 'page',
          'error.type': 'ECONNRESET',
        },
        1,
      ],
    ],
  );
});

test('an origin that answers 429 is a block counted for the origin and a warning that says until when', async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start(
    site(['/report'], (_path, response) => {
      response.writeHead(429, { 'retry-after': '3600' }).end();
    }),
  );
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });
  const before = Date.now();

  await assert.rejects(
    pipeline.run(),
    /answered 429, so the crawl requests nothing there/,
  );

  const blocks = (await telemetry.metrics()).find(
    ({ descriptor }) => descriptor.name === 'elt.origin.blocks',
  );
  assert.deepEqual(
    blocks?.dataPoints.map(({ attributes, value }) => [attributes, value]),
    [[{ 'elt.origin': upstream.origin }, 1]],
  );
  const warnings = telemetry
    .records()
    .filter(({ severityText }) => severityText === 'WARN');
  // The block is the origin's, not one crawl's, so its record is in the
  // trace of the pass.
  const [pass] = named(telemetry.spans(), 'elt.pass');
  assert.deepEqual(
    warnings.map(({ severityNumber, attributes, spanContext }) => [
      severityNumber,
      attributes['elt.origin'],
      spanContext?.spanId,
    ]),
    [[SeverityNumber.WARN, upstream.origin, pass?.spanContext().spanId]],
  );
  // The block ends when Retry-After says, an hour on.
  const until = Date.parse(String(warnings[0]?.attributes['elt.origin.until']));
  assert.ok(until >= before + 3_599_000 && until <= Date.now() + 3_600_000);
});

test('a connection that makes no pass is an error span of the pass and an error record of why', async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using data = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    streams: [{ stream: articles(), inputs: ['https://example.com/feed.xml'] }],
  });
  const destination = new SQLiteDestination({ path: data.path });
  // A wiring mistake: an incremental copy in a connection with no checkpoint
  // store, so the connection never reads.
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'miswired',
        source,
        destination,
        steps: [
          new Copy(
            (await source.discover()).get('articles'),
            destination.table('articles'),
            {
              id: 'miswired:articles',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
        ],
      }),
    ],
  });
  const why = 'Incremental copies require a stable id and checkpoint store';

  await assert.rejects(pipeline.run(), new TypeError(why));

  const passes = named(telemetry.spans(), 'elt.pass');
  assert.deepEqual(
    passes.map(({ attributes, status, duration }) => [
      attributes,
      status.code,
      status.message,
      duration,
    ]),
    // A wiring mistake is not one that the source names as the user's.
    [
      [
        { 'elt.connection': 'miswired', 'elt.failure_type': 'system' },
        SpanStatusCode.ERROR,
        why,
        [0, 0],
      ],
    ],
  );
  const errors = telemetry
    .records()
    .filter(({ severityText }) => severityText === 'ERROR');
  assert.deepEqual(
    errors.map(({ severityNumber, attributes, spanContext }) => [
      severityNumber,
      attributes['elt.connection'],
      attributes['elt.failure_type'],
      attributes['exception.message'],
      spanContext?.spanId,
    ]),
    [
      [
        SeverityNumber.ERROR,
        'miswired',
        'system',
        why,
        passes[0]?.spanContext().spanId,
      ],
    ],
  );
});

test('disabling exports the spans of the pass and the crawl that are open, and a later run records nothing', async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start(site(['/report']));
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });
  // The host stops its SDK once the crawl's first request ended: this
  // subscriber hears it after the instrumentation, which subscribed first.
  const stop = () => telemetry.instrumentation.disable();
  crawlChannels.request.subscribe(stop);

  try {
    await pipeline.run();
  } finally {
    crawlChannels.request.unsubscribe(stop);
  }
  const spans = telemetry.spans();
  const records = telemetry.records().length;
  const points = values(await telemetry.metrics());
  await pipeline.run();

  // A span is exported once it ends.
  assert.deepEqual(spans.map(({ name }) => name).toSorted(), [
    'elt.crawl',
    'elt.crawl.request',
    'elt.pass',
  ]);
  assert.equal(telemetry.spans().length, spans.length);
  assert.equal(telemetry.records().length, records);
  assert.deepEqual(values(await telemetry.metrics()), points);
});

test('a pass holds its crawl, which holds each request, timed by its HTTP exchange, and each extraction', async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // The site notes when the article's request reached it, and answers 200
  // ms later.
  let received = Number.NaN;
  const page = article('/report');
  await using upstream = await new HttpServer().start(
    site(['/report'], async (_path, response) => {
      received = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.writeHead(200, { 'content-type': 'text/html' }).end(page);
    }),
  );
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  const extracted: PageExtracted[] = [];
  const hear = (message: unknown) => {
    if (message instanceof PageExtracted) extracted.push(message);
  };
  pageChannels.extract.subscribe(hear);

  try {
    await pipeline.run();
  } finally {
    pageChannels.extract.unsubscribe(hear);
  }

  const spans = telemetry.spans();
  const [pass] = named(spans, 'elt.pass');
  assert.equal(pass?.attributes['elt.connection'], 'web');
  assert.equal(pass.status.code, SpanStatusCode.UNSET);
  assert.equal(pass.parentSpanContext, undefined);
  const [crawl] = named(spans, 'elt.crawl');
  assert.equal(parentOf(crawl!, spans), pass);
  assert.deepEqual(crawl?.attributes, {
    'elt.crawl.starts': [`${upstream.origin}/feed.xml`],
    'elt.crawl.resumed': false,
    'elt.crawl.complete': true,
  });
  const requests = named(spans, 'elt.crawl.request');
  assert.ok(requests.every((request) => parentOf(request, spans) === crawl));
  const report = requests.find(
    ({ attributes }) => attributes['url.full'] === `${upstream.origin}/report`,
  );
  const { port } = new URL(upstream.origin);
  assert.equal(report?.kind, SpanKind.CLIENT);
  assert.deepEqual(
    { ...report.attributes, 'elt.crawl.waited': undefined },
    {
      'url.full': `${upstream.origin}/report`,
      'server.address': '127.0.0.1',
      'server.port': Number(port),
      'http.response.status_code': 200,
      'http.response.body.size': Buffer.byteLength(page),
      'elt.crawl.lane': 'page',
      'elt.crawl.page': true,
      'elt.crawl.document': false,
      'elt.crawl.list': false,
      'elt.crawl.listing_url': `${upstream.origin}/feed.xml`,
      'elt.crawl.hops': 0,
      'elt.crawl.served': 'network',
      'elt.crawl.waited': undefined,
    },
  );
  // The origin's delay between the feed and the article, the crawler's
  // default of a second, in seconds.
  const waited = Number(report.attributes['elt.crawl.waited']);
  assert.ok(waited > 0.5 && waited < 1.5, `waited ${waited} s`);
  // The span is the exchange: it began before the site got the request, and
  // lasted at least the site's 200 ms.
  const milliseconds = ([seconds, nanos]: readonly [number, number]) =>
    seconds * 1000 + nanos / 1e6;
  assert.ok(milliseconds(report.startTime) <= received);
  assert.ok(milliseconds(report.endTime) >= received + 200);
  assert.ok(milliseconds(report.duration) >= 200);
  assert.equal(report.status.code, SpanStatusCode.UNSET);
  const [extraction] = named(spans, 'elt.web.extract');
  assert.equal(parentOf(extraction!, spans), crawl);
  assert.deepEqual(extraction?.attributes, {
    'url.full': `${upstream.origin}/report`,
    'elt.stream': 'articles',
    'elt.web.unchanged': false,
    'elt.web.records': 1,
  });
  // The extraction lasts what the page's reading and extracting took.
  const [published] = extracted;
  assert.ok(published?.extracted);
  assert.ok(
    Math.abs(
      milliseconds(extraction.duration) -
        published.read -
        published.extracted.duration,
    ) < 0.01,
  );
});

test("requests are counted and timed in seconds by origin, lane and status, and each origin's wait is timed", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start(
    site(['/report', '/missing'], async (path, response) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (path === '/missing') response.writeHead(404).end();
      else
        response
          .writeHead(200, { 'content-type': 'text/html' })
          .end(article(path));
    }),
  );
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  await assert.rejects(pipeline.run(), /could not read .*\/missing: .*404/);

  const metrics = await telemetry.metrics();
  const metric = (name: string) =>
    metrics.find(({ descriptor }) => descriptor.name === name);
  const origin = upstream.origin;
  const feed = {
    'elt.origin': origin,
    'elt.crawl.lane': 'listing',
    'http.response.status_code': 200,
  };
  const found = { ...feed, 'elt.crawl.lane': 'page' };
  const missing = {
    ...found,
    'http.response.status_code': 404,
    'error.type': '404',
  };
  assert.deepEqual(
    sorted(
      (metric('elt.crawl.requests')?.dataPoints ?? []).map(
        ({ attributes, value }) => [attributes, value],
      ),
    ),
    sorted([
      [feed, 1],
      [found, 1],
      [missing, 1],
    ]),
  );
  const durations = metric('elt.crawl.request.duration');
  assert.ok(durations?.dataPointType === DataPointType.HISTOGRAM);
  assert.equal(durations.descriptor.unit, 's');
  const boundaries = [
    0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
    30, 60,
  ];
  assert.deepEqual(
    sorted(
      durations.dataPoints.map(({ attributes, value }) => [
        attributes,
        value.count,
        value.buckets.boundaries,
      ]),
    ),
    sorted([
      [feed, 1, boundaries],
      [found, 1, boundaries],
      [missing, 1, boundaries],
    ]),
  );
  // The pages took the site's 100 ms: a tenth of a second, not a hundred.
  for (const { attributes, value } of durations.dataPoints)
    if (attributes['elt.crawl.lane'] === 'page')
      assert.ok(
        (value.sum ?? 0) >= 0.1 && (value.sum ?? 0) < 2,
        `${value.sum} s`,
      );
  const waits = metric('elt.crawl.request.wait');
  assert.ok(waits?.dataPointType === DataPointType.HISTOGRAM);
  assert.equal(waits.descriptor.unit, 's');
  // Three requests of one origin; the two pages each waited the origin's
  // delay, the crawler's default of a second.
  const [wait, ...others] = waits.dataPoints;
  assert.deepEqual(others, []);
  assert.deepEqual(wait?.attributes, { 'elt.origin': origin });
  assert.equal(wait.value.count, 3);
  assert.ok(
    (wait.value.sum ?? 0) > 1.5 && (wait.value.sum ?? 0) < 3.5,
    `${wait.value.sum} s`,
  );
});

test("the consumer's time with each entry, each page's extraction and each copy's committed records are measured, a second pass adding only its own", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // The article changes between the two runs, so each pass commits it.
  let edition = 1;
  await using upstream = await new HttpServer().start(
    site(['/report'], (path, response) => {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(article(`${path} edition ${edition}`));
    }),
  );
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const source = new WebSource({
    cachePath: join(cache.path, 'web-http.sqlite'),
    streams: [
      {
        stream: new WebStream({
          name: 'articles',
          primaryKey: ['articleUrl'],
          readers: [new ListingReader()],
          revisit: new AlwaysRevisit(),
          extractor: new ArticleExtractor(),
        }),
        inputs: [`${upstream.origin}/feed.xml`],
      },
    ],
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        source,
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  const handedOff: CrawlHandedOff[] = [];
  const extracted: PageExtracted[] = [];
  const hear = (message: unknown) => {
    if (message instanceof CrawlHandedOff) handedOff.push(message);
    if (message instanceof PageExtracted) extracted.push(message);
  };
  crawlChannels.handOff.subscribe(hear);
  pageChannels.extract.subscribe(hear);

  try {
    await pipeline.run();
    edition = 2;
    await pipeline.run();
  } finally {
    crawlChannels.handOff.unsubscribe(hear);
    pageChannels.extract.unsubscribe(hear);
  }

  const metrics = await telemetry.metrics();
  const metric = (name: string) =>
    metrics.find(({ descriptor }) => descriptor.name === name);
  // How many, and their sum in seconds, as the SDK adds them up.
  const total = (milliseconds: readonly number[]) => [
    milliseconds.length,
    milliseconds.reduce((sum, duration) => sum + duration / 1000, 0),
  ];
  const handOffs = metric('elt.crawl.handoff.duration');
  assert.ok(handOffs?.dataPointType === DataPointType.HISTOGRAM);
  assert.equal(handOffs.descriptor.unit, 's');
  // Each pass hands out the feed as progress and the article as a page.
  assert.deepEqual(
    sorted(
      handOffs.dataPoints.map(({ attributes, value }) => [
        attributes['elt.crawl.handoff.kind'],
        value.count,
        value.sum,
      ]),
    ),
    sorted(
      ['page', 'progress'].map((kind) => [
        kind,
        ...total(
          handedOff
            .filter((message) => message.kind === kind)
            .map(({ duration }) => duration),
        ),
      ]),
    ),
  );
  assert.equal(handedOff.length, 4);
  // A page's extraction is its reading and its extracting.
  const extractions = metric('elt.web.extract.duration');
  assert.ok(extractions?.dataPointType === DataPointType.HISTOGRAM);
  assert.equal(extractions.descriptor.unit, 's');
  assert.deepEqual(
    extractions.dataPoints.map(({ attributes, value }) => [
      attributes,
      value.count,
      value.sum,
    ]),
    [
      [
        { 'elt.stream': 'articles' },
        ...total(
          extracted.map(
            ({ read, extracted }) => read + (extracted?.duration ?? 0),
          ),
        ),
      ],
    ],
  );
  assert.equal(extracted.length, 2);
  assert.deepEqual(
    metric('elt.copy.records.committed')?.dataPoints.map(
      ({ attributes, value }) => [attributes, value],
    ),
    [[{ 'elt.connection': 'web', 'elt.stream': 'articles' }, 2]],
  );
});

test("the frontier's waiting and held URLs are gauged while a crawl runs, and none once it ended", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  let during: unknown[] = [];
  const frontier = async () =>
    values(await telemetry.metrics()).filter(([name]) =>
      String(name).startsWith('elt.crawl.frontier.'),
    );
  // The feed's origin blocks the crawl at its own article, which the crawl
  // then holds; the crawl goes on with the three articles that the feed lists
  // on another origin, which reads the gauges while it holds the third. The
  // origins take turns, and a request's message gives the frontier after it,
  // so /two's message is the first after the block, in either order.
  await using remote = await new HttpServer().start(
    site([], async (path, response) => {
      if (path === '/three') during = await frontier();
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(article(path));
    }),
  );
  await using upstream = await new HttpServer().start(
    site(
      [
        '/blocked',
        `${remote.origin}/one`,
        `${remote.origin}/two`,
        `${remote.origin}/three`,
      ],
      (_path, response) => {
        response.writeHead(429, { 'retry-after': '3600' }).end();
      },
    ),
  );
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  await assert.rejects(pipeline.run(), /answered 429/);

  const gauges = (page: number, held: number) => [
    [
      'elt.crawl.frontier.pending',
      [
        [{ 'elt.crawl.lane': 'listing' }, 0],
        [{ 'elt.crawl.lane': 'page' }, page],
        [{ 'elt.crawl.lane': 'link' }, 0],
        [{ 'elt.crawl.lane': 'backfill' }, 0],
      ],
    ],
    ['elt.crawl.frontier.held', [[{}, held]]],
  ];
  // After /two's request, /three waited, and the blocked article was held.
  assert.deepEqual(during, gauges(1, 1));
  // The crawl ended with the blocked article held, which counts no more.
  assert.deepEqual(await frontier(), gauges(0, 0));
});

test("a pass's and its crawl's starts and ends are records in the trace of their spans", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  await using upstream = await new HttpServer().start(site(['/report']));
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [
            { stream: articles(), inputs: [`${upstream.origin}/feed.xml`] },
          ],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  const before = Date.now();

  await pipeline.run();

  const spans = telemetry.spans();
  const [pass] = named(spans, 'elt.pass');
  const [crawl] = named(spans, 'elt.crawl');
  const ids = (span: ReadableSpan | undefined) => [
    span?.spanContext().traceId,
    span?.spanContext().spanId,
  ];
  assert.deepEqual(
    telemetry.records().map(({ severityText, attributes, spanContext }) => [
      severityText,
      // The crawl is due again by its revisit policy, a day on.
      'elt.crawl.next_due' in attributes
        ? {
            ...attributes,
            'elt.crawl.next_due':
              Date.parse(String(attributes['elt.crawl.next_due'])) > before,
          }
        : attributes,
      spanContext?.traceId,
      spanContext?.spanId,
    ]),
    [
      ['INFO', { 'elt.connection': 'web' }, ...ids(pass)],
      [
        'INFO',
        {
          'elt.crawl.starts': [`${upstream.origin}/feed.xml`],
          'elt.crawl.resumed': false,
        },
        ...ids(crawl),
      ],
      [
        'INFO',
        { 'elt.crawl.complete': true, 'elt.crawl.next_due': true },
        ...ids(crawl),
      ],
      ['INFO', { 'elt.connection': 'web' }, ...ids(pass)],
    ],
  );
});

test("a request that the origin's record served is internal, waited for nothing, and its tolerated 404 is no error", async () => {
  await using telemetry = install();
  await using cache = await new TemporaryFiles().directory('web-cache-');
  // A starting HTML page: the crawl reads its origin's robots.txt as a
  // document, the answer that the origin's record downloaded for its rules,
  // a 404, and asks for the sitemap that it guesses, a 404 too.
  await using upstream = await new HttpServer().start((request, response) => {
    if (request.url === '/')
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(article('/'));
    else response.writeHead(404).end();
  });
  await using data = await new Sqlite().database();
  await using checkpoints = await new Sqlite().database();
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      await connection(
        'web',
        new WebSource({
          cachePath: join(cache.path, 'web-http.sqlite'),
          streams: [{ stream: articles(), inputs: [`${upstream.origin}/`] }],
        }),
        ['articles'],
        data.path,
        checkpoints.path,
      ),
    ],
  });

  await pipeline.run();

  const requests = named(telemetry.spans(), 'elt.crawl.request');
  assert.deepEqual(
    requests
      .map(({ attributes, kind, status }) => [
        attributes['url.full'],
        attributes['elt.crawl.served'],
        attributes['http.response.status_code'],
        kind,
        status.code,
      ])
      .toSorted(),
    [
      [
        `${upstream.origin}/`,
        'network',
        200,
        SpanKind.CLIENT,
        SpanStatusCode.UNSET,
      ],
      [
        `${upstream.origin}/robots.txt`,
        'origin record',
        404,
        SpanKind.INTERNAL,
        SpanStatusCode.UNSET,
      ],
      // A 404 that the crawl got from the network is an error of the client.
      [
        `${upstream.origin}/sitemap.xml`,
        'network',
        404,
        SpanKind.CLIENT,
        SpanStatusCode.ERROR,
      ],
    ].toSorted(),
  );
  // Only the two network requests waited for the origin.
  const waits = (await telemetry.metrics()).find(
    ({ descriptor }) => descriptor.name === 'elt.crawl.request.wait',
  );
  assert.ok(waits?.dataPointType === DataPointType.HISTOGRAM);
  assert.deepEqual(
    waits.dataPoints.map(({ value }) => value.count),
    [2],
  );
});
