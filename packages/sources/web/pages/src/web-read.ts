import type { PipelineClock } from '@workspace/elt';

import type { WebClient } from './http/web-http.ts';
import type { WebScan } from './web-scan.ts';

/** What the streams of one read share: the delivery of routes between them, the HTTP of every crawl, and the clock of the pipeline. */
export class WebRead implements AsyncDisposable {
  readonly scan: WebScan;
  readonly client: WebClient;
  readonly clock: PipelineClock;

  constructor(scan: WebScan, client: WebClient, clock: PipelineClock) {
    this.scan = scan;
    this.client = client;
    this.clock = clock;
  }

  async [Symbol.asyncDispose]() {
    await this.client[Symbol.asyncDispose]();
  }
}
