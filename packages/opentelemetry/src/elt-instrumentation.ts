import { AsyncLocalStorage } from 'node:async_hooks';

import {
  type Attributes,
  SeverityNumber,
  type Span,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from '@opentelemetry/api';
import {
  InstrumentationBase,
  type InstrumentationConfig,
} from '@opentelemetry/instrumentation';

import {
  CopyProgress,
  PassFailed,
  PassFinished,
  PassStarted,
  passChannels,
} from '@workspace/elt';
import {
  type Crawl,
  CrawlEnded,
  CrawlHandedOff,
  CrawlRequested,
  CrawlStarted,
  OriginBlocked,
  crawlChannels,
} from '@workspace/sdk-web-crawler';
import {
  PageExtracted,
  pageChannels,
} from '@workspace/source-web-pages/page-channels';

import { Instruments } from './instruments.ts';

const channels = [
  passChannels.start,
  passChannels.progress,
  passChannels.finish,
  passChannels.failure,
  crawlChannels.start,
  crawlChannels.request,
  crawlChannels.handOff,
  crawlChannels.end,
  crawlChannels.block,
  pageChannels.extract,
];

/**
 * Turns what elt publishes on its diagnostics channels into OpenTelemetry
 * spans, metrics and log records, as instrumentation-undici turns undici's
 * channels into spans and metrics: a host installs it with its SDK, such as
 * NodeSDK's instrumentations.
 */
export class EltInstrumentation extends InstrumentationBase {
  // The base constructor calls _updateMetricInstruments() and enable() before
  // this class's own fields exist, so what they set is declared here and set
  // there, as instrumentation-undici sets its histogram and subscriptions
  // (contrib 47ab4c2def, undici.ts:68-156).
  declare private instruments: Instruments;
  declare private pass: AsyncLocalStorage<PassStarted>;
  declare private listener: (message: unknown) => void;
  readonly #passes = new Map<PassStarted, Span>();
  readonly #crawls = new Map<Crawl, Span>();
  // The last request of each open crawl: its frontier now.
  readonly #frontiers = new Map<Crawl, CrawlRequested>();
  // What each running copy had committed at its last progress, so the
  // counter adds what is new; a copy that ends starts from none again.
  readonly #committed = new WeakMap<CopyProgress['copy'], number>();

  constructor(config: InstrumentationConfig = {}) {
    super('@workspace/elt-opentelemetry', '0.0.1', config);
  }

  // elt publishes on channels, so no module is patched.
  protected override init() {
    return undefined;
  }

  protected override _updateMetricInstruments() {
    this.instruments = new Instruments(this.meter, () => [
      ...this.#frontiers.values(),
    ]);
  }

  override enable() {
    if (this.isEnabled()) return;
    super.enable();
    // The pipeline runs each pass in the stores bound to its start, so the
    // store holds the pass in every message that the pass publishes.
    this.pass = new AsyncLocalStorage();
    passChannels.start.bindStore(this.pass);
    this.listener = (message) => this.#hear(message);
    for (const channel of channels) channel.subscribe(this.listener);
  }

  override disable() {
    if (!this.isEnabled()) return;
    super.disable();
    passChannels.start.unbindStore(this.pass);
    for (const channel of channels) channel.unsubscribe(this.listener);
    // What is open now never hears its end.
    for (const span of [...this.#crawls.values(), ...this.#passes.values()])
      span.end();
    this.#crawls.clear();
    this.#frontiers.clear();
    this.#passes.clear();
  }

  #hear(message: unknown) {
    if (message instanceof PassStarted) this.#passStarted(message);
    if (message instanceof CopyProgress) this.#progressed(message);
    if (message instanceof PassFinished) this.#passFinished(message);
    if (message instanceof PassFailed) this.#passFailed(message);
    if (message instanceof CrawlStarted) this.#crawlStarted(message);
    if (message instanceof CrawlRequested) this.#requested(message);
    if (message instanceof CrawlHandedOff) this.#handedOff(message);
    if (message instanceof PageExtracted) this.#extracted(message);
    if (message instanceof CrawlEnded) this.#crawlEnded(message);
    if (message instanceof OriginBlocked) this.#blocked(message);
  }

  #passStarted(message: PassStarted) {
    const attributes = { 'elt.connection': message.connection.name };
    const span = this.tracer.startSpan(
      'elt.pass',
      { attributes },
      context.active(),
    );
    this.#passes.set(message, span);
    this.#log(
      'INFO',
      `Connection ${message.connection.name} began a pass`,
      attributes,
      span,
    );
  }

  #progressed(message: CopyProgress) {
    const { copy, committed, status } = message;
    this.instruments.committed.add(
      committed.count - (this.#committed.get(copy) ?? 0),
      {
        'elt.connection': message.connection.name,
        'elt.stream': copy.from.name,
      },
    );
    if (status === 'running') this.#committed.set(copy, committed.count);
    else this.#committed.delete(copy);
  }

  #passFinished(message: PassFinished) {
    const started = this.pass.getStore();
    if (started === undefined) return;
    const span = this.#passes.get(started);
    this.#passes.delete(started);
    this.#log(
      'INFO',
      `Connection ${message.connection.name} ended its pass`,
      { 'elt.connection': message.connection.name },
      span,
    );
    const failed = message.outcomes.flatMap(({ copy, failures }) =>
      failures.length > 0 ? [copy.id ?? copy.from.name] : [],
    );
    if (failed.length > 0)
      span?.setStatus({
        code: SpanStatusCode.ERROR,
        message: `${failed.join(', ')} did not load completely`,
      });
    span?.end();
  }

  // A connection that made no pass, such as one that its validation stopped,
  // failed outside any pass: its pass is a span of no length.
  #passFailed(message: PassFailed) {
    const now = Date.now();
    const span = this.tracer.startSpan(
      'elt.pass',
      {
        startTime: now,
        attributes: {
          'elt.connection': message.connection.name,
          'elt.failure_type': message.failureType,
        },
      },
      context.active(),
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorMessage(message.error),
    });
    span.end(now);
    this.#log(
      'ERROR',
      `Connection ${message.connection.name} made no pass: ${errorMessage(message.error)}`,
      {
        'elt.connection': message.connection.name,
        'elt.failure_type': message.failureType,
      },
      span,
      message.error,
    );
  }

  #crawlStarted(message: CrawlStarted) {
    const attributes = {
      'elt.crawl.starts': [...message.starts],
      'elt.crawl.resumed': message.resumed,
    };
    const span = this.tracer.startSpan(
      'elt.crawl',
      { attributes },
      within(this.#pass()),
    );
    this.#crawls.set(message.crawl, span);
    this.#log(
      'INFO',
      `Crawl ${message.resumed ? 'continues' : 'starts'}: ${message.starts.join(' ')}`,
      attributes,
      span,
    );
  }

  // A request is a client span, timed by Got's timings, as OpenTelemetry's
  // HTTP client conventions name its attributes; one that the origin's record
  // served sent nothing, so it is internal. Its outcome is the answer's
  // status, and error.type for no answer or a 4xx or 5xx answer, which make
  // only a client span an error (OpenTelemetry's HTTP span status): the
  // crawl tolerates a robots.txt of 404.
  #requested(message: CrawlRequested) {
    this.#frontiers.set(message.crawl, message);
    const { outcome } = message;
    const timings = 'timings' in outcome ? outcome.timings : null;
    const url = new URL(message.url);
    const result: Attributes =
      'error' in outcome
        ? { 'error.type': errorType(outcome.error) }
        : {
            'http.response.status_code': outcome.status,
            ...(outcome.status >= 400
              ? { 'error.type': String(outcome.status) }
              : {}),
          };
    const span = this.tracer.startSpan(
      'elt.crawl.request',
      {
        kind:
          message.served === 'network' ? SpanKind.CLIENT : SpanKind.INTERNAL,
        ...(timings === null ? {} : { startTime: timings.start }),
        attributes: {
          'url.full': message.url,
          'server.address': url.hostname,
          // An origin on its scheme's port has no port in its URL.
          'server.port':
            Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
          ...result,
          ...('bytes' in outcome
            ? { 'http.response.body.size': outcome.bytes }
            : {}),
          'elt.crawl.lane': message.lane,
          'elt.crawl.page': message.page,
          'elt.crawl.document': message.document,
          'elt.crawl.list': message.list,
          'elt.crawl.listing_url': message.listingUrl,
          'elt.crawl.hops': message.hops,
          'elt.crawl.served': message.served,
          'elt.crawl.waited': message.waited / 1000,
        },
      },
      within(this.#crawls.get(message.crawl)),
    );
    if ('error.type' in result && message.served === 'network')
      span.setStatus({
        code: SpanStatusCode.ERROR,
        ...('error' in outcome ? { message: errorMessage(outcome.error) } : {}),
      });
    span.end(timings?.end);
    const measured = {
      'elt.origin': url.origin,
      'elt.crawl.lane': message.lane,
      ...result,
    };
    this.instruments.requests.add(1, measured);
    // An answer that the HTTP cache gave has no timings, and a request that
    // the origin's record served waited for nothing.
    if (timings?.phases.total !== undefined)
      this.instruments.requestDuration.record(
        timings.phases.total / 1000,
        measured,
      );
    if (message.served === 'network')
      this.instruments.requestWait.record(message.waited / 1000, {
        'elt.origin': url.origin,
      });
    if ('error' in outcome)
      this.#log(
        'WARN',
        `${message.url} got no answer: ${errorMessage(outcome.error)}`,
        { 'url.full': message.url, 'elt.origin': url.origin, ...result },
        span,
      );
  }

  #handedOff(message: CrawlHandedOff) {
    this.instruments.handOffDuration.record(message.duration / 1000, {
      'elt.crawl.handoff.kind': message.kind,
    });
  }

  // The page's reading and extracting, which end as the message is published.
  #extracted(message: PageExtracted) {
    const duration = message.read + (message.extracted?.duration ?? 0);
    this.instruments.extractDuration.record(duration / 1000, {
      'elt.stream': message.stream,
    });
    const end = Date.now();
    this.tracer
      .startSpan(
        'elt.web.extract',
        {
          startTime: end - duration,
          attributes: {
            'url.full': message.url,
            'elt.stream': message.stream,
            'elt.web.unchanged': message.extracted === null,
            'elt.web.records': message.extracted?.records ?? 0,
          },
        },
        within(this.#crawls.get(message.crawl)),
      )
      .end(end);
  }

  // A record in the context of its span, so it carries the span's trace.
  #log(
    severity: 'INFO' | 'WARN' | 'ERROR',
    body: string,
    attributes: Attributes,
    span: Span | undefined,
    exception?: unknown,
  ) {
    this.logger.emit({
      severityNumber: SeverityNumber[severity],
      severityText: severity,
      body,
      attributes,
      context: within(span),
      ...(exception === undefined ? {} : { exception }),
    });
  }

  // A block is the origin's, shared by every crawl of the read, so its record
  // is in the trace of the pass.
  #blocked(message: OriginBlocked) {
    this.instruments.blocks.add(1, { 'elt.origin': message.origin });
    const until = new Date(message.until).toISOString();
    this.#log(
      'WARN',
      `${message.origin} blocked the crawl until ${until}`,
      { 'elt.origin': message.origin, 'elt.origin.until': until },
      this.#pass(),
    );
  }

  // The span of the pass whose work runs now.
  #pass() {
    const started = this.pass.getStore();
    return started === undefined ? undefined : this.#passes.get(started);
  }

  #crawlEnded(message: CrawlEnded) {
    const span = this.#crawls.get(message.crawl);
    span?.setAttribute('elt.crawl.complete', message.complete);
    const due =
      message.nextDue === null ? null : new Date(message.nextDue).toISOString();
    this.#log(
      'INFO',
      `Crawl ends ${message.complete ? 'complete' : 'incomplete'}${due === null ? '' : `, due again ${due}`}`,
      {
        'elt.crawl.complete': message.complete,
        ...(due === null ? {} : { 'elt.crawl.next_due': due }),
      },
      span,
    );
    span?.end();
    this.#crawls.delete(message.crawl);
    this.#frontiers.delete(message.crawl);
  }
}

// The active context, with parent as its span when there is one.
function within(parent: Span | undefined) {
  return parent === undefined
    ? context.active()
    : trace.setSpan(context.active(), parent);
}

// A name of an error with few values, as OpenTelemetry's error.type asks:
// Node's code, such as ECONNRESET, or the error's class; _OTHER otherwise.
function errorType(error: unknown) {
  if (!Error.isError(error)) return '_OTHER';
  return 'code' in error && typeof error.code === 'string'
    ? error.code
    : error.name;
}

function errorMessage(error: unknown) {
  return Error.isError(error) ? error.message : String(error);
}
