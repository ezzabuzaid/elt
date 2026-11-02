# elt OpenTelemetry

A host wants to see its passes and crawls in a backend such as Grafana. The bridge turns what elt publishes on its diagnostics channels into OpenTelemetry signals. This glossary gives the words that the README and the decisions use.

## Language

**Bridge**:
`EltInstrumentation`, an OpenTelemetry instrumentation that subscribes to elt's channels and makes spans, metrics and log records. A host gives it to its SDK ([ADR 0001](./docs/adr/0001-elt-publishes-on-channels-and-one-bridge-makes-opentelemetry.md)).
_Avoid_: Exporter, adapter, logger

**Pass span**:
The `elt.pass` span of one pass of one connection, from its start to its end. A connection that made no pass, such as one that its validation stopped, has a pass span of no length with an error status.
_Avoid_: Sync span, run span

**Crawl span**:
The `elt.crawl` span of one crawl, from its start to its end. It is a child of the pass span of the pass that runs the crawl.
_Avoid_: Job span

**Request span**:
The `elt.crawl.request` span of one URL of the frontier, timed by Got's timings of its HTTP exchange. It is a child of its crawl span.
_Avoid_: Fetch span

**Outcome**:
The answer of a request as OpenTelemetry's HTTP conventions name it: `http.response.status_code`, and `error.type` when the request got no answer or a 4xx or 5xx answer.
_Avoid_: Result, status class

**Frontier gauge**:
`elt.crawl.frontier.pending` and `elt.crawl.frontier.held`: the URLs that the frontiers of the open crawls hold now, the sum of the last request of each crawl that has not ended.
_Avoid_: Queue size, backlog

**Milestone record**:
An INFO log record of the start or the end of a pass or a crawl, in the trace of its span.
_Avoid_: Event, progress line
