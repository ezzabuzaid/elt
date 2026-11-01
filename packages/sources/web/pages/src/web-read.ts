import type { WebClient } from './http/web-http.ts';
import type { WebScan } from './web-scan.ts';

/** What the streams of one read share: the delivery of routes between them, and the HTTP of every crawl. */
export class WebRead implements AsyncDisposable {
  readonly scan: WebScan;
  readonly client: WebClient;

  constructor(scan: WebScan, client: WebClient) {
    this.scan = scan;
    this.client = client;
  }

  async [Symbol.asyncDispose]() {
    await this.client[Symbol.asyncDispose]();
  }
}
