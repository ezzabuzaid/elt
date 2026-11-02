import { channel } from 'node:diagnostics_channel';

import type { Crawl } from '@workspace/sdk-web-crawler';

// What the web source publishes of each page it reads, on a
// node:diagnostics_channel channel, as the crawler publishes its requests
// (crawlChannels of @workspace/sdk-web-crawler). A subscriber gets each
// message as unknown and tells it by its class; crawl is the crawl that
// handed the page out, as on the crawler's messages.
export const pageChannels = { extract: channel('elt:web.extract') };

/**
 * The records that a page gave, once the source read it. read is how long the
 * extractor took to read the page and give its fingerprint. extracted is null
 * when the fingerprint was the one of the last read, so the source extracted
 * no records; otherwise it is the records and how long extracting them took.
 */
export class PageExtracted {
  readonly crawl: Crawl;
  readonly stream: string;
  readonly url: string;
  readonly read: number;
  readonly extracted: {
    readonly records: number;
    readonly duration: number;
  } | null;
  constructor(
    crawl: Crawl,
    stream: string,
    url: string,
    read: number,
    extracted: { readonly records: number; readonly duration: number } | null,
  ) {
    this.crawl = crawl;
    this.stream = stream;
    this.url = url;
    this.read = read;
    this.extracted = extracted;
  }
}
