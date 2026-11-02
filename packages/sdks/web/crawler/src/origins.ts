import { setTimeout } from 'node:timers/promises';

import { Latch, untilAborted } from '@zukhruf/async';
import {
  type BeforeRedirectHook,
  type Got,
  HTTPError,
  MaxRedirectsError,
  type Response,
} from 'got';
import { z } from 'zod';

import { day, hour } from './revisit-policy.ts';
import { RobotsRules } from './robots-rules.ts';

const recordSchema = z.object({
  // The origin's robots.txt and when it was read. An answer that allows
  // everything, such as a 404, is kept as an empty body.
  robots: z.object({ body: z.string(), fetched: z.number() }).nullable(),
  // When the origin's breaker closes, by the clock; null when it never opened.
  blocked: z.number().nullable(),
  // How long the crawl waits between two requests to the origin after it refused some, in milliseconds.
  slowdown: z.number().nonnegative(),
});

const mementoSchema = z.record(z.string(), recordSchema);

/** What an origin's record keeps across reads: its robots.txt, the end of its block and its slowdown. */
export type OriginMemento = z.infer<typeof recordSchema>;

/** Every origin's record as plain data, by origin. */
export type OriginsMemento = z.infer<typeof mementoSchema>;

/** An origin that could not give its robots.txt: its breaker is open until `until`. */
export type Unreachable = { readonly until: number; readonly cause: unknown };

/** A request that the record of its origin refused before it was sent: a block, unreachable rules, or rules that disallow the URL. */
class RefusedRequest extends Error {
  override readonly name = 'RefusedRequest';
}

// The robots.txt of an origin that the read did not ask yet, or whose rules expired.
class Unread {}

// The robots.txt of an origin that a request is reading now; read opens when it ends.
class Reading {
  readonly read: Latch;
  constructor(read: Latch) {
    this.read = read;
  }
}

// The rules of an origin, and when the crawl read them.
class Read {
  readonly rules: RobotsRules;
  readonly fetched: number;
  constructor(rules: RobotsRules, fetched: number) {
    this.rules = rules;
    this.fetched = fetched;
  }
}

// Rules that this read downloaded, with the answer they came from, which the
// crawls' robots.txt documents read: one download gives the rules and the
// sitemaps. Rules that an earlier read left in the memento have no answer.
class Downloaded extends Read {
  readonly answer: Response;
  constructor(rules: RobotsRules, fetched: number, answer: Response) {
    super(rules, fetched);
    this.answer = answer;
  }
}

// One origin's record. saved is what outlives the read; it is replaced, not
// changed, so a host can tell a changed record by its identity.
class Origin {
  saved: OriginMemento;
  robots: Unread | Reading | Read;
  // 403 answers in a row.
  forbidden = 0;
  // When the last request to the origin starts, by the high-resolution clock.
  started = -Infinity;
  // The documents of one-step expansions that the read downloaded here.
  documents = 0;
  // The end of a block that opened in this read: it holds to the read's
  // end, as Nutch clears a blocked host's queue for the round.
  opened: number | null = null;

  constructor(saved: OriginMemento, robots: Unread | Read) {
    this.saved = saved;
    this.robots = robots;
  }
}

/**
 * The record of each origin that the crawls of one read share, as Heritrix
 * keeps one CrawlServer for each host in its ServerCache and Nutch one
 * FetchItemQueue for each host: the origin's robots.txt, its breaker, its
 * slowdown, the start of its last request, its delay and its expansion
 * budget. Politeness is a property of the host, not of a crawl (Introduction
 * to Information Retrieval §20.2.3). The memento keeps what outlives the read,
 * as Nutch's HostDb keeps each host across cycles.
 */
export class Origins {
  /**
   * The client for requests that no crawl's frontier holds, such as the HTML
   * companion of a Markdown page. Each request, and each redirect it follows,
   * passes the record of its own origin first: its block, its robots.txt and
   * its delay. Each answer counts as a crawl's does.
   */
  readonly http: Got;
  // The caller's client, for robots.txt.
  readonly #http: Got;
  // The client's user agent, which robots.txt groups name.
  readonly #agent: string;
  // Got's retried statuses without the refusals: a refusal is the record's, not Got's.
  readonly #retried: readonly number[];
  readonly #origins: Map<string, Origin>;

  /** A null memento knows no origin. */
  constructor(http: Got, memento: unknown) {
    const agent = http.defaults.options.headers['user-agent'];
    this.#agent = typeof agent === 'string' ? agent : '*';
    this.#http = http;
    // Got types retry as Partial, but its Options always hold statusCodes (got 16.1.0 source/core/options.js:486).
    this.#retried = http.defaults.options.retry.statusCodes!.filter(
      (status) => !refused(status),
    );
    this.#origins = new Map(
      Object.entries(mementoSchema.nullable().parse(memento) ?? {}).map(
        ([origin, saved]) => [
          origin,
          new Origin(
            saved,
            saved.robots === null
              ? new Unread()
              : new Read(
                  new RobotsRules(
                    `${origin}/robots.txt`,
                    saved.robots.body,
                    this.#agent,
                  ),
                  saved.robots.fetched,
                ),
          ),
        ],
      ),
    );
    this.http = http.extend({
      retry: { statusCodes: [...this.#retried] },
      hooks: {
        beforeRequest: [
          async (options) => this.#admit(target(options), options.signal),
        ],
        beforeRedirect: [
          async (options, response) => {
            this.answered(
              response.url,
              response.statusCode,
              response.headers['retry-after'] ?? null,
              false,
            );
            await this.#admit(target(options), options.signal);
          },
        ],
        afterResponse: [
          (response) => {
            this.answered(
              response.url,
              response.statusCode,
              response.headers['retry-after'] ?? null,
              false,
            );
            return response;
          },
        ],
      },
    });
  }

  /** Every origin's record as plain data. A record that did not change is the same object as in the last snapshot. */
  snapshot(): OriginsMemento {
    return Object.fromEntries(
      [...this.#origins].map(([origin, { saved }]) => [origin, saved]),
    );
  }

  /** The options for a request of a crawl: Got retries no refusal, which is the record's. */
  get retry() {
    return { statusCodes: [...this.#retried] };
  }

  /** When the origin's breaker closes, or null when it is closed now. */
  until(origin: string): number | null {
    const { opened, saved } = this.#record(origin);
    if (opened !== null) return opened;
    return saved.blocked !== null && saved.blocked > Date.now()
      ? saved.blocked
      : null;
  }

  /** Whether a request to the origin would wait for nothing. */
  ready(origin: string) {
    return this.#askable(this.#record(origin)) <= performance.now();
  }

  /** Waits until the origin can be asked again, and takes that moment for the next request. */
  async pace(origin: string, signal: AbortSignal | undefined) {
    const record = this.#record(origin);
    const until = this.#askable(record);
    record.started = Math.max(until, performance.now());
    // A timer can fire up to a millisecond early by the high-resolution clock.
    for (
      let wait = until - performance.now();
      wait > 0;
      wait = until - performance.now()
    )
      await setTimeout(wait, undefined, { signal }).catch((error: unknown) => {
        signal?.throwIfAborted();
        throw error;
      });
  }

  /** Whether the origin can download one more document for one-step expansions in this read. */
  expands(origin: string) {
    return this.#record(origin).documents < expansionDocuments;
  }

  /** One document of a one-step expansion downloads from the origin. */
  spend(origin: string) {
    this.#record(origin).documents++;
  }

  /**
   * The origin's rules, from its robots.txt, read through the caller's
   * client, so its HTTP cache applies, and kept for 24 hours, the longest
   * that RFC 9309 §2.4 lets a crawler cache them. Got follows five redirects
   * (RFC 9309 §2.3.1.2), each through the record of its own origin. A 5xx or
   * a 429 answer, or no answer, opens the origin's breaker: unreachable rules
   * disallow everything for now (§2.3.1.4).
   */
  async rules(
    origin: string,
    signal: AbortSignal | undefined,
  ): Promise<RobotsRules | Unreachable> {
    const robots = await this.#robots(origin, signal, false);
    return robots instanceof Read ? robots.rules : robots;
  }

  /**
   * The answer of the origin's robots.txt in this read, for a crawl's
   * robots.txt document, so the read downloads it once for its rules and its
   * sitemaps, as StormCrawler's FetcherBolt discovers sitemaps from the
   * robots lookup that gave its rules and Nutch's SitemapProcessor from its
   * robot rules. Rules that an earlier read left in the memento are
   * downloaded again here, as the document needs an answer. Null when
   * robots.txt redirected more than five times, which allows everything.
   */
  async robotsTxt(
    origin: string,
    signal: AbortSignal | undefined,
  ): Promise<Response | Unreachable | null> {
    const robots = await this.#robots(origin, signal, true);
    if (!(robots instanceof Read)) return robots;
    return robots instanceof Downloaded ? robots.answer : null;
  }

  // The origin's rules, read again once they are 24 hours old, or when an
  // answer is needed and the rules have none. A request that reads them while
  // another waits for them shares the one answer.
  async #robots(
    origin: string,
    signal: AbortSignal | undefined,
    answered: boolean,
  ): Promise<Read | Unreachable> {
    const record = this.#record(origin);
    for (;;) {
      const { robots } = record;
      if (
        robots instanceof Read &&
        Date.now() < robots.fetched + robotsLifetime &&
        (!answered || robots instanceof Downloaded)
      )
        return robots;
      if (!(robots instanceof Reading)) break;
      await untilAborted(robots.read.wait(), signal);
    }
    const read = new Latch();
    record.robots = new Reading(read);
    try {
      const robots = await this.#read(origin, record, signal);
      if (robots instanceof Read) return robots;
      record.robots = new Unread();
      return robots;
    } catch (error) {
      record.robots = new Unread();
      throw error;
    } finally {
      read.open();
    }
  }

  /**
   * Counts an answer of the URL's origin. A refusal, a 429 or a 5xx, doubles
   * the origin's slowdown, from one second up to one minute, as Google's
   * crawler lowers its rate for a host that answers 429 or 5xx; each other
   * answer shortens it by a tenth. Returns when the breaker closes if the
   * answer opened it: a 429, a 503 with Retry-After (RFC 9110 §10.2.3 and
   * §15.6.4), or a third 403 in a row, unless the request tolerated the
   * status. A Retry-After that Node's headers lack is null.
   */
  answered(
    url: string,
    status: number,
    retryAfter: string | null,
    tolerated: boolean,
  ): number | null {
    const { origin } = new URL(url);
    const record = this.#record(origin);
    this.#slow(record, status);
    // A 403 can close one page, such as a members-only one, so only a run
    // of them, as Nutch's fetcher.max.exceptions.per.queue counts, is a block.
    record.forbidden = status === 403 && !tolerated ? record.forbidden + 1 : 0;
    if (
      tolerated ||
      !(
        status === 429 ||
        (status === 503 && retryAfter !== null) ||
        record.forbidden >= forbiddenRun
      )
    )
      return null;
    return this.#open(origin, retryAfter);
  }

  #record(origin: string) {
    return this.#origins.getOrInsertComputed(
      origin,
      () =>
        new Origin({ robots: null, blocked: null, slowdown: 0 }, new Unread()),
    );
  }

  // When the origin can be asked again: its delay after its last request
  // started, plus its slowdown, as Nutch adds its exception back-off to a
  // queue's next fetch time (FetchItemQueues.java:331). The delay is its
  // Crawl-delay, which Bing and Yandex honor and RFC 9309 does not define, or
  // one second without one, as StormCrawler's fetcher.server.delay.
  #askable(record: Origin) {
    const crawlDelay =
      record.robots instanceof Read
        ? Math.min(record.robots.rules.crawlDelay(), maxCrawlDelay)
        : 0;
    return (
      record.started +
      (crawlDelay > 0 ? crawlDelay * 1000 : delay) +
      record.saved.slowdown
    );
  }

  async #read(
    origin: string,
    record: Origin,
    signal: AbortSignal | undefined,
  ): Promise<Read | Unreachable> {
    const url = `${origin}/robots.txt`;
    await this.pace(origin, signal);
    let body = '';
    let answer: Response | null = null;
    try {
      const response = await this.#http(url, {
        signal,
        responseType: 'text',
        throwHttpErrors: false,
        maxRedirects: 5,
        context: { page: false },
        retry: { statusCodes: [...this.#retried] },
        hooks: { beforeRedirect: [this.#hop] },
      });
      this.#slow(
        this.#record(new URL(response.url).origin),
        response.statusCode,
      );
      // A 5xx answer disallows everything until the server is back; a 4xx one
      // allows everything, except a 429, which asks to slow down, so it holds
      // the origin as Google's crawler treats it and as a page's 429 does.
      if (response.statusCode >= 500 || response.statusCode === 429)
        return {
          until: this.#open(origin, response.headers['retry-after'] ?? null),
          cause: new HTTPError(response),
        };
      if (response.ok) body = response.body;
      answer = response;
    } catch (cause) {
      signal?.throwIfAborted();
      // More redirects than five make the rules unavailable, as a 4xx does.
      if (!(cause instanceof MaxRedirectsError))
        return { until: this.#open(origin, null), cause };
    }
    const rules = new RobotsRules(url, body, this.#agent);
    const fetched = Date.now();
    const robots =
      answer === null
        ? new Read(rules, fetched)
        : new Downloaded(rules, fetched, answer);
    record.robots = robots;
    record.saved = { ...record.saved, robots: { body, fetched } };
    return robots;
  }

  // A redirect of robots.txt: the answer counts for its origin, and the next
  // request waits for the block and the delay of its own origin. robots.txt
  // itself is always allowed.
  readonly #hop: BeforeRedirectHook = async (options, response) => {
    this.#slow(this.#record(new URL(response.url).origin), response.statusCode);
    const { origin } = target(options);
    const until = this.until(origin);
    if (until !== null)
      throw new RefusedRequest(
        `${origin} is blocked until ${new Date(until).toISOString()}`,
      );
    await this.pace(origin, options.signal);
  };

  // A request outside a crawl's frontier waits for the block, the rules and
  // the delay of its origin, as a crawl's request does.
  async #admit(url: URL, signal: AbortSignal | undefined) {
    const { origin } = url;
    const until = this.until(origin);
    if (until !== null)
      throw new RefusedRequest(
        `${origin} is blocked until ${new Date(until).toISOString()}`,
      );
    if (url.href !== `${origin}/robots.txt`) {
      const rules = await this.rules(origin, signal);
      if (!(rules instanceof RobotsRules))
        throw new RefusedRequest(
          `${origin} could not give its robots.txt, so nothing is requested there until ${new Date(rules.until).toISOString()}`,
          { cause: rules.cause },
        );
      if (!rules.allows(url.href))
        throw new RefusedRequest(
          `The robots.txt of ${origin} disallows ${url.href}`,
        );
    }
    await this.pace(origin, signal);
  }

  // Each refusal doubles the slowdown; each other answer shortens it by a
  // tenth, so the crawl returns to its full rate while the origin answers.
  #slow(record: Origin, status: number) {
    const { slowdown } = record.saved;
    let next = refused(status)
      ? Math.min(longestSlowdown, Math.max(firstSlowdown, slowdown * 2))
      : slowdown * 0.9;
    if (next < shortestSlowdown) next = 0;
    if (next !== slowdown) record.saved = { ...record.saved, slowdown: next };
  }

  #open(origin: string, retryAfter: string | null) {
    const until = blockedUntil(retryAfter);
    const record = this.#record(origin);
    record.saved = { ...record.saved, blocked: until };
    record.opened = until;
    return until;
  }
}

// An answer that asks the crawl to slow down: 429 Too Many Requests or a server error.
function refused(status: number) {
  return status === 429 || status >= 500;
}

// The URL of a request that a Got hook sees; Got resolves it before any hook runs.
function target({ url }: { readonly url: URL | undefined }) {
  if (!(url instanceof URL))
    throw new TypeError('A request reached the origin record without a URL');
  return url;
}

// When a block ends, by its Retry-After in seconds or as an HTTP-date (RFC
// 9110 §10.2.3), at most a day later; an hour later without one.
function blockedUntil(retryAfter: string | null) {
  const now = Date.now();
  if (retryAfter === null) return now + unannouncedBlock;
  const value = retryAfter.trim();
  const until = /^\d+$/.test(value)
    ? now + Number(value) * 1000
    : Date.parse(value);
  return Number.isNaN(until)
    ? now + unannouncedBlock
    : Math.min(until, now + longestBlock);
}

// The time between the starts of two requests to one origin without a
// Crawl-delay: one second, as StormCrawler's fetcher.server.delay. Nutch
// waits 5 seconds and Heritrix at least 3; one second keeps one origin at
// one request a second, the rate a host that names no Crawl-delay is assumed
// to bear, while a crawl of many origins still moves.
const delay = 1000;

// The longest Crawl-delay the crawl honors, in seconds: a longer one waits 60
// seconds, so the crawl never leaves an origin's URLs out. Nutch skips an
// origin above 30 seconds and Heritrix honors up to 300.
const maxCrawlDelay = 60;

// How long robots.txt rules are kept: RFC 9309 §2.4 lets a crawler cache them for 24 hours at most.
const robotsLifetime = day;

// A block without a Retry-After lasts an hour, as StormCrawler keeps a failed
// robots.txt lookup in its error cache for an hour.
const unannouncedBlock = hour;

// The longest block a Retry-After sets: a day, as StormCrawler caps the
// Retry-After it honors (urlfrontier.max.retry.after, 86400 seconds).
const longestBlock = day;

// 403 answers in a row from one origin that make a block.
const forbiddenRun = 3;

// A refused origin's first slowdown, its longest, and the shortest one it
// keeps, in milliseconds. Each refusal doubles it, as TCP doubles its
// back-off; one minute is the longest Crawl-delay honored; under 100 ms the
// wait no longer slows a crawl that waits a second anyway.
const firstSlowdown = 1000;
const longestSlowdown = 60_000;
const shortestSlowdown = 100;

// The documents that one read downloads for the one-step expansions on one
// origin. An expansion reads one robots.txt and the sitemaps it names; a
// small site names one to three, as vercel.com names one, so its program
// page comes back in one run. A site with hundreds, as www.microsoft.com's
// 505, is read over many runs. ADR 0005 gives the reasons for the number.
const expansionDocuments = 8;
