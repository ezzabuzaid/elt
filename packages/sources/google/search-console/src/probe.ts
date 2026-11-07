import { type Check, Gauge } from '@zukhruf/async';

// A fingerprint of what Google returns for some streams, read at each check:
// a change wakes those streams.
export class Probe extends Gauge<string> {
  readonly #read: (check: Check) => Promise<string>;

  constructor(read: (check: Check) => Promise<string>) {
    super();
    this.#read = read;
  }

  protected read(check: Check) {
    return this.#read(check);
  }
}
