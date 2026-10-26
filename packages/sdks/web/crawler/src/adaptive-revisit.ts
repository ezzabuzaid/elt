import { z } from 'zod';

import {
  type Change,
  type Revisit,
  RevisitPolicy,
  type Schedule,
  day,
  hour,
} from './revisit-policy.ts';

const historySchema = z.object({ interval: z.number().positive() });
type History = z.infer<typeof historySchema>;

// StormCrawler's AdaptiveScheduler defaults: a first interval of one day,
// between one hour and fourteen days, changed by half each visit.
const first = day;
const shortest = hour;
const longest = 14 * day;
const rate = 0.5;

/**
 * A URL that changed is due sooner, one that did not later, as StormCrawler's
 * AdaptiveScheduler and Nutch's AdaptiveFetchSchedule. A shorter interval
 * moves toward the shortest one, so it slows near it.
 */
export class AdaptiveRevisit extends RevisitPolicy<History> {
  readonly histories = historySchema;

  protected visited(
    { at, outcome }: Revisit & { readonly outcome: Change },
    history: History | null,
  ): Schedule<History> {
    let interval: number;
    if (history === null) interval = first;
    else if (outcome === 'unknown') interval = history.interval;
    else if (outcome === 'modified')
      interval = (1 - rate) * history.interval + rate * shortest;
    else interval = Math.min(longest, (1 + rate) * history.interval);
    return { due: at + interval, history: { interval } };
  }
}
