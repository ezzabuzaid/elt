import { Latch, untilAborted } from '@zukhruf/async';
import { z } from 'zod';

import { routeHows } from '@workspace/sdk-web-crawler';

/**
 * The groups of routes that the crawls of one input found and that its
 * routes stream has not committed, in the state of the web stream: a
 * transactional outbox. The web stream commits its crawl's progress with
 * them, and its routes stream reads beside it as the relay: it takes each
 * group once a checkpoint of the web stream committed it, so a run that
 * stops between the two commits gives them again. Each group has a number,
 * and the routes stream's state keeps the number of the first group it did
 * not commit.
 */
export const outbox = z.array(
  z.object({
    seq: z.number().int().nonnegative(),
    listingUrl: z.string(),
    // Every reader read the response, so the routes replace the listing's rows.
    complete: z.boolean(),
    routes: z
      .array(
        z.object({
          url: z.string(),
          how: z.enum(routeHows),
          text: z.string().nullable(),
        }),
      )
      .readonly(),
  }),
);
export type Outbox = z.infer<typeof outbox>;

// The crawl of the input goes on; arrived opens when it gives more groups or ends.
class Crawling {
  readonly arrived: Latch;
  constructor(arrived: Latch) {
    this.arrived = arrived;
  }
}

/** How the crawl of one input in a read ended: whether it reached its end, when it ended, and the pages whose last visit failed. */
export type CrawlEnd = {
  readonly complete: boolean;
  readonly at: string;
  readonly failures: readonly string[];
};

// The crawl of the input ended; null when it never starts in this read.
class Ended {
  readonly crawl: CrawlEnd | null;
  constructor(crawl: CrawlEnd | null) {
    this.crawl = crawl;
  }
}

// The groups that the crawl of one input gave its routes stream and that the
// routes stream has not taken yet.
class Delivery {
  readonly #groups: Outbox[number][] = [];
  #state: Crawling | Ended = new Crawling(new Latch());

  give(groups: Outbox) {
    if (groups.length === 0 || this.#state instanceof Ended) return;
    this.#groups.push(...groups);
    const { arrived } = this.#state;
    this.#state = new Crawling(new Latch());
    arrived.open();
  }

  end(crawl: CrawlEnd | null) {
    if (this.#state instanceof Ended) return;
    const { arrived } = this.#state;
    this.#state = new Ended(crawl);
    arrived.open();
  }

  async ended(signal: AbortSignal | undefined): Promise<CrawlEnd | null> {
    while (this.#state instanceof Crawling)
      await untilAborted(this.#state.arrived.wait(), signal);
    return this.#state.crawl;
  }

  // Every group that arrived since the last take, together, until the crawl ended.
  async *take(signal: AbortSignal | undefined): AsyncGenerator<Outbox> {
    for (;;) {
      if (this.#groups.length > 0) {
        yield this.#groups.splice(0);
        continue;
      }
      if (this.#state instanceof Ended) return;
      await untilAborted(this.#state.arrived.wait(), signal);
    }
  }
}

/**
 * What the streams of one read share about routes: the web streams that it
 * crawls, and which of them have their routes stream in the read too, the
 * first group that each of those routes streams did not commit, and the
 * delivery of each input's crawl.
 */
export class WebScan {
  readonly #routed: ReadonlySet<string>;
  readonly #undelivered: ReadonlyMap<string, number>;
  readonly #deliveries: ReadonlyMap<string, Delivery>;
  // Every input of each web stream that the read crawls, by stream, in the order it reads them.
  readonly #inputs: ReadonlyMap<string, readonly string[]>;

  constructor(
    crawled: ReadonlyMap<string, readonly string[]>,
    routed: Iterable<string>,
    undelivered: ReadonlyMap<string, number>,
  ) {
    this.#inputs = crawled;
    this.#routed = new Set(routed);
    this.#undelivered = undelivered;
    this.#deliveries = new Map(
      [...crawled].flatMap(([stream, inputs]) =>
        inputs.map((inputUrl) => [`${stream}\0${inputUrl}`, new Delivery()]),
      ),
    );
  }

  /** Whether this read selects the routes stream of the web stream too. */
  routed(stream: string) {
    return this.#routed.has(stream);
  }

  /** The number of the first group that the routes stream of the input did not commit. */
  undelivered(stream: string, inputUrl: string) {
    // A routes stream that committed nothing for the input has no state for it.
    return this.#undelivered.get(`${stream}\0${inputUrl}`) ?? 0;
  }

  /** Gives the routes stream of the input groups that the web stream committed. */
  give(stream: string, inputUrl: string, groups: Outbox) {
    if (this.routed(stream))
      this.#deliveries.get(`${stream}\0${inputUrl}`)?.give(groups);
  }

  /** The crawl of the input ended, as crawl says, and gives no more groups; null when it did not begin. */
  end(stream: string, inputUrl: string, crawl: CrawlEnd | null) {
    this.#deliveries.get(`${stream}\0${inputUrl}`)?.end(crawl);
  }

  /** A full refresh that failed reads no later input, so no later crawl starts. */
  stop(stream: string) {
    for (const inputUrl of this.#inputs.get(stream) ?? [])
      this.#deliveries.get(`${stream}\0${inputUrl}`)?.end(null);
  }

  /** The groups of the crawl of the input as they arrive; none when this read does not crawl it. */
  take(stream: string, inputUrl: string, signal: AbortSignal | undefined) {
    return this.#deliveries.get(`${stream}\0${inputUrl}`)?.take(signal);
  }

  /** How the crawl of the input ended, once it ended: null when it did not start, undefined when this read does not crawl its stream. */
  async ended(
    stream: string,
    inputUrl: string,
    signal: AbortSignal | undefined,
  ) {
    return this.#deliveries.get(`${stream}\0${inputUrl}`)?.ended(signal);
  }
}
