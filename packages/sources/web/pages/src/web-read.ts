import type { PipelineClock } from '@workspace/elt';

import type { WebClient } from './http/web-http.ts';
import type { WebScan } from './web-scan.ts';

/** What the streams of one read share: the delivery of routes between them, the HTTP of every crawl, and the clock of the pipeline. */
export class WebRead implements AsyncDisposable {
  readonly scan: WebScan;
  readonly client: WebClient;
  readonly clock: PipelineClock;
  /** Aborts when the read stops, or when the client's cache fails. */
  readonly signal: AbortSignal;
  readonly #end: () => Promise<void>;

  private constructor(
    scan: WebScan,
    client: WebClient,
    clock: PipelineClock,
    signal: AbortSignal,
    end: () => Promise<void>,
  ) {
    this.scan = scan;
    this.client = client;
    this.clock = clock;
    this.signal = signal;
    this.#end = end;
  }

  /** A read with a client of its own: the client opened with the read's signal, and the read's end closes it. */
  static owning(scan: WebScan, client: WebClient, clock: PipelineClock) {
    return new WebRead(scan, client, clock, client.signal, () =>
      client[Symbol.asyncDispose](),
    );
  }

  /** A read through the host's client: it also stops with its own signal, and its end saves the origins' records and leaves the client open for the host. */
  static borrowing(
    scan: WebScan,
    client: WebClient,
    signal: AbortSignal | undefined,
    clock: PipelineClock,
  ) {
    return new WebRead(
      scan,
      client,
      clock,
      signal === undefined
        ? client.signal
        : AbortSignal.any([signal, client.signal]),
      () => client.save(),
    );
  }

  async [Symbol.asyncDispose]() {
    await this.#end();
  }
}
