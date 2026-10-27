import { EventEmitter, on } from 'node:events';

import type { Activity as State } from './contract.ts';

// EventEmitter keeps no last value, and a page that connects mid-sync needs it.
class Activity {
  #current: State = { kind: 'idle' };
  readonly #changes = new EventEmitter<{ change: [State] }>();

  get current(): State {
    return this.#current;
  }

  publish(next: State) {
    this.#current = next;
    this.#changes.emit('change', next);
  }

  // Subscribes now, so a change published before the first read is buffered.
  changes(signal: AbortSignal) {
    return on(this.#changes, 'change', { signal });
  }
}

export default new Activity();
