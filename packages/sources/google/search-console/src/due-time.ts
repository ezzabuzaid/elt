import { type Check, Gauge } from '@zukhruf/async';

// The last due time that a stream reached. Its value changes at the first
// check after the stream falls due, so a watch reads the stream at most one
// interval late, and not again until a later due time passes (elt ADR 0020).
export class DueTime extends Gauge<number> {
  // When the stream falls due next, from its last read; Infinity when it
  // has none.
  readonly #dueAt: () => number;
  #reached = Number.NEGATIVE_INFINITY;

  constructor(dueAt: () => number) {
    super();
    this.#dueAt = dueAt;
  }

  protected async read(check: Check): Promise<number> {
    const at = this.#dueAt();
    if (at <= check.now) this.#reached = at;
    return this.#reached;
  }
}
