import { z } from 'zod';

import { IntervalRevisit } from './interval-revisit.ts';
import type { Schedule } from './revisit-policy.ts';

/**
 * A URL is read once: after a download that succeeded it is never due again,
 * as a request queue keeps the detail pages it handled, unless a listing gives
 * it another lastModified. A failed or gone URL is asked again, as with every
 * IntervalRevisit.
 */
export class OnceRevisit extends IntervalRevisit<null> {
  readonly histories = z.null();

  protected visited(): Schedule<null> {
    return { due: null, history: null };
  }
}
