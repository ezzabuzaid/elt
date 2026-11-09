# elt publishes on channels, and one bridge makes OpenTelemetry

A host wants to see a crawl while it runs: how many requests each origin gets, where the time goes, which origins block, and how each crawl ends. elt already publishes these facts on `node:diagnostics_channel` channels (`passChannels`, `crawlChannels`, `pageChannels`). Before this package, one host read them as console text (logful's `CrawlLog`), and no other host could use that text.

Thus `@eltjs/elt-opentelemetry` turns the channels into OpenTelemetry spans, metrics and log records. elt and its packages do not depend on OpenTelemetry. A host installs the bridge with its SDK, and the SDK sends the signals to a backend that the host chooses, such as `grafana/otel-lgtm`. This is the way of `@opentelemetry/instrumentation-undici`: undici publishes on its channels, and the instrumentation subscribes and makes the spans (opentelemetry-js-contrib 47ab4c2def, `undici.ts`). Node asks a module to publish what it does on channels, so that tools can subscribe (`doc/api/diagnostics_channel.md`).

## Considered Options

- **elt depends on `@opentelemetry/api` and makes the spans itself.** Every host then loads OpenTelemetry, also a host that wants none. Each elt package must agree on the names, and a change of a convention changes elt.
- **Each host reads the channels in its own way.** logful's `CrawlLog` did this. Each host then has a copy of the same work, and its text has no trace, no histogram and no dashboard.
- **One bridge package subscribes to the channels.** This option was selected.

## Consequences

- elt keeps publishing facts and knows no backend. A new fact goes onto a channel first, and then into the bridge.
- The bridge follows OpenTelemetry's conventions where one exists: the HTTP client attributes (`url.full`, `server.address`, `http.response.status_code`, `error.type`) and durations in seconds. Names of elt's own concepts start with `elt.`.
- A host that installs no SDK pays nothing: the channels have no subscribers.
- The repository ships one Grafana dashboard for these signals, `dashboards/crawl.json`, as StormCrawler's OpenSearch module ships `dashboards/metrics.ndjson` for its metrics (`external/opensearch/archetype/src/main/resources/archetype-resources/dashboards`).
