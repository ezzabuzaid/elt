import type { Got } from 'got';

import {
  type CrawlClock,
  OriginRecords,
  type OriginsMemento,
} from './origin-records.ts';
import type { Reader } from './reader.ts';
import type { RevisitPolicy } from './revisit-policy.ts';
import { WebCrawler } from './web-crawler.ts';

/**
 * One read, as its host sees it: the record of each origin, which every
 * crawl of the read asks (ADR 0006), the client for requests outside a
 * crawl, and the crawlers of the read, which it makes. Thus a host cannot
 * change a record, and no crawler asks the records of another read, as
 * Scrapy's downloader keeps the slot of each domain to itself.
 */
export class Origins {
  readonly #records: OriginRecords;
  readonly #clock: CrawlClock;
  /**
   * The client for requests that no crawl's frontier holds, such as the HTML
   * companion of a Markdown page. Each request, and each redirect it follows,
   * passes the record of its own origin first: its block, its robots.txt and
   * its delay. Each answer counts as a crawl's does.
   */
  readonly http: Got;

  /**
   * A null memento knows no origin. The read waits and reads the time on
   * clock: a host gives globalThis, a test a fake clock that it moves.
   */
  constructor(http: Got, memento: unknown, clock: CrawlClock) {
    this.#clock = clock;
    this.#records = new OriginRecords(http, memento, clock);
    this.http = this.#records.http;
  }

  /**
   * A crawler of this read: it sends its requests through http, gives each
   * response to the readers in their order, and asks revisit when each URL
   * is due again.
   */
  crawler(
    http: Got,
    readers: readonly Reader<unknown, unknown>[],
    revisit: RevisitPolicy<unknown>,
  ): WebCrawler {
    return new WebCrawler(http, this.#records, readers, revisit, this.#clock);
  }

  /** Every origin's record as plain data, for the next read. */
  snapshot(): OriginsMemento {
    return this.#records.snapshot();
  }
}
