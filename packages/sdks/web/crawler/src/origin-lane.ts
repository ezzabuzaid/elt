/**
 * The URLs of one priority, kept by origin. Origins take turns: each take
 * gives the oldest URL of the origin at the front and moves that origin to
 * the back, so one origin's many URLs cannot hold up the URLs of another
 * (head-of-line blocking). These are the back queues of a crawl frontier,
 * one for each host (Introduction to Information Retrieval §20.2.3), and
 * Heritrix's WorkQueueFrontier, which moves a queue that used its turn to
 * the back.
 */
export class OriginLane<Item extends { readonly url: string }> {
  // Each origin's URLs in the order found; the map's order is the order of turns.
  readonly #origins = new Map<string, Map<string, Item>>();
  #size = 0;

  get size() {
    return this.#size;
  }

  get(url: string) {
    return this.#origins.get(new URL(url).origin)?.get(url);
  }

  set(item: Item) {
    // A new origin takes its turn after every origin that waits.
    const items = this.#origins.getOrInsertComputed(
      new URL(item.url).origin,
      () => new Map(),
    );
    if (!items.has(item.url)) this.#size++;
    items.set(item.url, item);
  }

  delete(url: string) {
    const { origin } = new URL(url);
    const items = this.#origins.get(origin);
    if (items === undefined || !items.delete(url)) return;
    this.#size--;
    if (items.size === 0) this.#origins.delete(origin);
  }

  /**
   * The oldest URL of the first origin in turn that is ready, which leaves
   * the lane; the first origin in turn when none is. An origin that must
   * still wait out its Crawl-delay or slowdown thus lets a ready one go
   * first, as the back-queue heap of a crawl frontier orders hosts by the
   * earliest time each can be asked again.
   */
  take(ready: (origin: string) => boolean): Item | undefined {
    let turn: [string, Map<string, Item>] | undefined;
    for (const candidate of this.#origins) {
      turn ??= candidate;
      if (ready(candidate[0])) {
        turn = candidate;
        break;
      }
    }
    if (turn === undefined) return undefined;
    const [origin, items] = turn;
    // An origin stays in the lane only while it holds a URL.
    for (const [url, item] of items) {
      items.delete(url);
      this.#size--;
      this.#origins.delete(origin);
      if (items.size > 0) this.#origins.set(origin, items);
      return item;
    }
    return undefined;
  }

  *values() {
    for (const items of this.#origins.values()) yield* items.values();
  }
}
