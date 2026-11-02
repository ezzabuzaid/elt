import { channel } from 'node:diagnostics_channel';

import type { Timings } from 'got';

import type { Priority } from './reader.ts';

// What each crawl publishes while it runs, on node:diagnostics_channel
// channels, as elt's pipeline publishes its passes (elt passChannels) and Got
// its requests. A subscriber gets each message as unknown and tells it by its
// class. A host that runs several crawls tells its own by an
// AsyncLocalStorage, as Node calls a subscriber in the async context of the
// publisher. A subscriber that throws does not stop the crawl, but Node
// reports the error as an uncaught exception.
export const crawlChannels = {
  start: channel('elt:crawl.start'),
  request: channel('elt:crawl.request'),
  handOff: channel('elt:crawl.handOff'),
  end: channel('elt:crawl.end'),
  block: channel('elt:origin.block'),
};

/** A crawl began, new or continued from a memento with an unfinished crawl. */
export class CrawlStarted {
  readonly starts: readonly string[];
  readonly resumed: boolean;
  constructor(starts: readonly string[], resumed: boolean) {
    this.starts = starts;
    this.resumed = resumed;
  }
}

/**
 * The answer that a request got: its status, its body's bytes and Got's
 * timings, which an answer that the HTTP cache gave without a request has
 * none of (Got 16.1.0 source/core/index.ts, the timings getter of Request).
 */
export type Answered = {
  readonly status: number;
  readonly bytes: number;
  readonly timings: Timings | null;
};

/** A request that got no answer, such as a network error after Got's retries. */
export type Errored = { readonly error: unknown };

/**
 * One URL of the frontier, once its request ended, as Heritrix's crawl.log
 * has a line for each URI. lane is the frontier lane it waited in; page,
 * document and list are the roles that readers gave it. waited is how long
 * the crawl waited for the delay and the slowdown of its origin before the
 * request, as StormCrawler measures a URL's time in its queues. A robots.txt
 * that the origin's record downloaded for its rules in this read is served by
 * the record: the crawl waited for nothing and sent no request.
 */
export class CrawlRequested {
  readonly url: string;
  readonly lane: Priority;
  readonly page: boolean;
  readonly document: boolean;
  readonly list: boolean;
  readonly listingUrl: string;
  readonly hops: number;
  readonly served: 'network' | 'origin record';
  readonly waited: number;
  readonly outcome: Answered | Errored;
  // The frontier after the request: the URLs waiting in each lane, and those
  // that a block or a spent expansion budget holds.
  readonly pending: Readonly<Record<Priority, number>>;
  readonly held: number;
  constructor(request: {
    readonly url: string;
    readonly lane: Priority;
    readonly page: boolean;
    readonly document: boolean;
    readonly list: boolean;
    readonly listingUrl: string;
    readonly hops: number;
    readonly served: 'network' | 'origin record';
    readonly waited: number;
    readonly outcome: Answered | Errored;
    readonly pending: Readonly<Record<Priority, number>>;
    readonly held: number;
  }) {
    this.url = request.url;
    this.lane = request.lane;
    this.page = request.page;
    this.document = request.document;
    this.list = request.list;
    this.listingUrl = request.listingUrl;
    this.hops = request.hops;
    this.served = request.served;
    this.waited = request.waited;
    this.outcome = request.outcome;
    this.pending = request.pending;
    this.held = request.held;
  }
}

/**
 * The time from handing an entry to the crawl's consumer to the consumer's
 * next pull: the consumer's work on it, such as extracting and committing a
 * page. The crawl requests nothing in that time: back-pressure, as Flink
 * counts a task's backPressuredTimeMsPerSecond.
 */
export class CrawlHandedOff {
  readonly url: string;
  readonly kind: 'page' | 'failure' | 'progress' | 'deferral';
  readonly duration: number;
  constructor(
    url: string,
    kind: 'page' | 'failure' | 'progress' | 'deferral',
    duration: number,
  ) {
    this.url = url;
    this.kind = kind;
    this.duration = duration;
  }
}

/** A crawl ended: complete when it reached its end with every page read. */
export class CrawlEnded {
  readonly complete: boolean;
  readonly nextDue: number | null;
  constructor(complete: boolean, nextDue: number | null) {
    this.complete = complete;
    this.nextDue = nextDue;
  }
}

/** The breaker of an origin opened: no crawl of the read requests it until until. */
export class OriginBlocked {
  readonly origin: string;
  readonly until: number;
  constructor(origin: string, until: number) {
    this.origin = origin;
    this.until = until;
  }
}
