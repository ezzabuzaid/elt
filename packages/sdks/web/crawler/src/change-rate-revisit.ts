import { z } from 'zod';

import { IntervalRevisit } from './interval-revisit.ts';
import {
  type Change,
  type Revisit,
  type Schedule,
  day,
  hour,
} from './revisit-policy.ts';

const historySchema = z.object({
  // The visit that the next one compares with.
  at: z.number(),
  // Visits that could compare a body with the one before, and how many found it changed.
  compared: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  // The time those visits covered.
  elapsed: z.number().nonnegative(),
});
type History = z.infer<typeof historySchema>;

const longest = 14 * day;

/**
 * A URL is due after the time it takes to change, as estimated from its
 * visits: Cho and Garcia-Molina's estimator for a Poisson process seen at
 * regular visits, -log((n - X + 0.5) / (n + 0.5)) changes per visit, where X
 * of n compared visits found a change (Estimating Frequency of Change, ACM
 * TOIT 2003). The estimate is finite even when every visit found a change,
 * and a URL that never changed waits the longest, fourteen days.
 */
export class ChangeRateRevisit extends IntervalRevisit<History> {
  readonly histories = historySchema;

  protected visited(
    { at, outcome }: Revisit & { readonly outcome: Change },
    history: History | null,
  ): Schedule<History> {
    if (history === null || outcome === 'unknown') {
      const next = { compared: 0, changed: 0, elapsed: 0, ...history, at };
      return { due: at + day, history: next };
    }
    const next = {
      at,
      compared: history.compared + 1,
      changed: history.changed + (outcome === 'modified' ? 1 : 0),
      elapsed: history.elapsed + (at - history.at),
    };
    const perVisit = -Math.log(
      (next.compared - next.changed + 0.5) / (next.compared + 0.5),
    );
    const interval =
      perVisit === 0 ? longest : next.elapsed / next.compared / perVisit;
    return {
      due: at + Math.min(longest, Math.max(hour, interval)),
      history: next,
    };
  }
}
