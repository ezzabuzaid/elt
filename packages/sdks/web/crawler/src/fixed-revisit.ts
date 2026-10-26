import { z } from 'zod';

import { IntervalRevisit } from './interval-revisit.ts';
import { type Revisit, type Schedule } from './revisit-policy.ts';

/** Every URL is due one fixed interval after its visit, as Nutch's DefaultFetchSchedule. */
export class FixedRevisit extends IntervalRevisit<null> {
  readonly histories = z.null();
  readonly #every: number;

  constructor({ every }: { readonly every: number }) {
    super();
    if (!Number.isSafeInteger(every) || every < 0)
      throw new RangeError(
        'A revisit interval must be a non-negative safe integer of milliseconds',
      );
    this.#every = every;
  }

  protected visited({ at }: Revisit): Schedule<null> {
    return { due: at + this.#every, history: null };
  }
}
