import { z } from 'zod';

import { routeHows } from '@workspace/sdk-web-crawler';

/**
 * The groups of routes that the crawls of one input found and that its
 * routes stream has not committed, in the state of the web stream: a
 * transactional outbox. The web stream commits its crawl's progress with
 * them, and its routes stream reads after it, so a run that stops between
 * the two commits gives them again. Each group has a number, and the routes
 * stream's state keeps the number of the first group it did not commit.
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

/**
 * What the streams of one read share: the web streams whose routes stream the
 * read selects, the first group that each of those routes streams did not
 * commit, and the outbox of the crawl of each input. The read takes each web
 * stream before its routes stream, so a routes stream takes the outbox of a
 * crawl that has ended.
 */
export class WebScan implements AsyncDisposable {
  readonly #routed: ReadonlySet<string>;
  readonly #undelivered: ReadonlyMap<string, number>;
  readonly #outboxes = new Map<string, Outbox>();

  constructor(
    routed: Iterable<string>,
    undelivered: ReadonlyMap<string, number>,
  ) {
    this.#routed = new Set(routed);
    this.#undelivered = undelivered;
  }

  /** Whether this read selects the routes stream of the web stream. */
  routed(stream: string) {
    return this.#routed.has(stream);
  }

  /** The number of the first group that the routes stream of the input did not commit. */
  undelivered(stream: string, inputUrl: string) {
    // A routes stream that committed nothing for the input has no state for it.
    return this.#undelivered.get(`${stream}\0${inputUrl}`) ?? 0;
  }

  /** The outbox of the web stream's input, which its crawl adds to. */
  offer(stream: string, inputUrl: string, groups: Outbox) {
    this.#outboxes.set(`${stream}\0${inputUrl}`, groups);
  }

  /** The outbox that the web stream's crawl of the input gave, if it crawled it in this read. */
  take(stream: string, inputUrl: string) {
    return this.#outboxes.get(`${stream}\0${inputUrl}`);
  }

  async [Symbol.asyncDispose]() {}
}
