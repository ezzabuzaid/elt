# elt OpenTelemetry

`EltInstrumentation` turns what elt publishes on its diagnostics channels into OpenTelemetry spans, metrics and log records: the passes of a pipeline, the crawls of the web crawler, their requests, and the pages that the web source extracts. elt does not depend on OpenTelemetry. The host installs the bridge with its SDK ([ADR 0001](./docs/adr/0001-elt-publishes-on-channels-and-one-bridge-makes-opentelemetry.md)).

```ts
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { EltInstrumentation } from '@workspace/elt-opentelemetry';

const sdk = new NodeSDK({
  serviceName: 'logful',
  traceExporter: new OTLPTraceExporter(),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 5000,
    }),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
  ],
  instrumentations: [new EltInstrumentation(globalThis)],
});
sdk.start();
await using telemetry = new AsyncDisposableStack();
telemetry.defer(() => sdk.shutdown());
await pipeline.run();
```

- Start the SDK before the pipeline runs. The bridge records only what it hears.
- Shut the SDK down after the pipeline, also when the pipeline throws. The shutdown exports what the processors and the reader still hold. `NodeSDK` is not disposable, so `AsyncDisposableStack` runs its `shutdown()`.
- The OTLP exporters send to `http://localhost:4318` when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set.
- `disable()` ends the spans of the passes and crawls that are open, and the bridge records nothing after it.

## Traces

Each span is a child of the span above it, also when two passes or two crawls run at the same time.

| Span                | From → to                         | Attributes                                                                                                                                                                                                            |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elt.pass`          | `PassStarted` → `PassFinished`    | `elt.connection`. An error when a copy did not load completely.                                                                                                                                                       |
| `elt.pass`          | `PassFailed`, no length           | `elt.connection`, `elt.failure_type`. An error with the reason.                                                                                                                                                       |
| `elt.crawl`         | `CrawlStarted` → `CrawlEnded`     | `elt.crawl.starts`, `elt.crawl.resumed`, `elt.crawl.complete`                                                                                                                                                         |
| `elt.crawl.request` | Got's timings of the exchange     | `url.full`, `server.address`, `server.port`, `http.response.status_code`, `http.response.body.size`, `error.type`, `elt.crawl.lane`, `.page`, `.document`, `.list`, `.listing_url`, `.hops`, `.served`, `.waited` (s) |
| `elt.web.extract`   | the page's reading and extracting | `url.full`, `elt.stream`, `elt.web.unchanged`, `elt.web.records`                                                                                                                                                      |

- A request span is a client span. A request that the origin's record served sent nothing, so its span is internal.
- A client span with no answer, or with a 4xx or 5xx answer, is an error, as OpenTelemetry's HTTP span status says. Its `error.type` is Node's code, such as `ECONNRESET`, or the status. An internal span is no error: the crawl tolerates a `robots.txt` of 404 that the origin's record served, and its `error.type` still names the status.

## Metrics

| Instrument                   | Kind         | Attributes                                                                                |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `elt.crawl.requests`         | counter      | `elt.origin`, `elt.crawl.lane`, `http.response.status_code`, `error.type`                 |
| `elt.crawl.request.duration` | histogram, s | the same                                                                                  |
| `elt.crawl.request.wait`     | histogram, s | `elt.origin`: the time that a request waited for the delay and the slowdown of its origin |
| `elt.crawl.handoff.duration` | histogram, s | `elt.crawl.handoff.kind`: the time of the crawl's consumer with each entry                |
| `elt.web.extract.duration`   | histogram, s | `elt.stream`                                                                              |
| `elt.copy.records.committed` | counter      | `elt.connection`, `elt.stream`                                                            |
| `elt.origin.blocks`          | counter      | `elt.origin`                                                                              |
| `elt.crawl.frontier.pending` | gauge        | `elt.crawl.lane`: the URLs that wait in the frontiers of the open crawls                  |
| `elt.crawl.frontier.held`    | gauge        | none: the URLs that a block or a spent budget holds                                       |

- The histograms use OpenTelemetry's buckets for HTTP durations, from 0.005 s to 10 s, and 30 s and 60 s for slow pages and long waits.
- A request that the HTTP cache answered has no timings, so it has no duration. A request that the origin's record served waited for nothing, so it has no wait.
- The gauges read 0 when no crawl is open.

## Log records

Each record is in the trace of its span, so a backend links the record and the span.

| Severity | When                                            | Attributes                                              |
| -------- | ----------------------------------------------- | ------------------------------------------------------- |
| INFO     | a pass starts and ends; a crawl starts and ends | as on the span; a crawl's end also `elt.crawl.next_due` |
| WARN     | a request got no answer                         | `url.full`, `elt.origin`, `error.type`                  |
| WARN     | an origin blocked the crawls of a read          | `elt.origin`, `elt.origin.until`, in the pass's trace   |
| ERROR    | a connection made no pass                       | `elt.connection`, `elt.failure_type`, `exception.*`     |

## The dashboard

`dashboards/crawl.json` is a Grafana dashboard of these signals. It reads the data sources of `grafana/otel-lgtm` by their uids: `prometheus`, `tempo` and `loki`. elt's infra starts that image, and Grafana loads the dashboard from this folder:

```sh
npx nx run infra:up-otel     # Grafana on http://localhost:3000, OTLP on http://localhost:4318
npx nx run infra:down-otel
```

Each Prometheus query has a min interval of 5 s, the export interval of the example above, so Grafana's `$__rate_interval` is 20 s and not 4 minutes, which the 60 s scrape interval of `otel-lgtm`'s data source gives. A host that exports less often sets the min interval of the panels to its interval.

The panels are the requests of each origin, their outcomes, the blocks, where the crawl's time goes (the wait for the origin, HTTP, the consumer and the extraction), the request time of each origin, the frontier by lane, the held URLs, the records committed by stream, the recent crawls from Tempo, and the warnings and errors from Loki.

On 2026-11-02, context-compiler's logful crawled `https://www.anthropic.com/news` into a new data folder, started with plain `node`, while `infra:up-otel` ran. The pass took 284 s and made 288 requests: 3 listings, 281 pages that answered 200 and 4 redirects (308). It committed 281 records. Of the 284 s, the requests waited 176 s for the delay of the origin, HTTP took 84 s and the consumer 22 s, of which the extraction took 20 s. The request time was 0.32 s at p50 and 0.49 s at p95. Prometheus gave series for each query of the dashboard, Tempo held the trace of the pass, its crawl and its requests, and Loki held the four milestone records with the trace id. A second run that SIGINT stopped after 20 s ended by the signal and still exported "Crawl ends incomplete" and the end of its pass.
