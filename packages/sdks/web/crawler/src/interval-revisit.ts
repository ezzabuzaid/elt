import {
  type Change,
  type Revisit,
  RevisitPolicy,
  type Schedule,
  day,
  hour,
} from './revisit-policy.ts';

/**
 * How long a URL waits after its first gone visit. A listing can still name
 * a page that answers 404 and comes back later, so it is asked again, as
 * Nutch's setPageGoneSchedule does, not never, as StormCrawler's default does.
 */
const firstGone = day;
/** Each later gone visit waits half again as long, as Nutch's setPageGoneSchedule. */
const goneGrowth = 1.5;
/** The longest wait of a gone URL, as Nutch's db.fetch.interval.max: every URL is asked again within it. */
const longestGone = 90 * day;

/**
 * A policy that waits a fixed time after a failed visit, a growing time after
 * a gone one, and decides only the interval after a download that succeeded,
 * as Nutch's AbstractFetchSchedule.
 */
export abstract class IntervalRevisit<History> extends RevisitPolicy<History> {
  /** How long a failed URL waits, as StormCrawler's fetchInterval.fetch.error. */
  protected readonly retryAfter: number = 2 * hour;

  schedule(revisit: Revisit, history: History | null): Schedule<History> {
    const { at, outcome } = revisit;
    if (outcome === 'failed') return { due: at + this.retryAfter, history };
    if (typeof outcome === 'object' && 'gone' in outcome)
      return {
        due:
          at +
          Math.min(longestGone, firstGone * goneGrowth ** (outcome.gone - 1)),
        history,
      };
    // A redirect is a visit that succeeded, as Nutch's CrawlDbReducer gives
    // STATUS_FETCH_REDIR_TEMP and _PERM to setFetchSchedule with a fetched
    // page; its target decides whether it changed.
    return this.visited(
      {
        ...revisit,
        outcome: typeof outcome === 'string' ? outcome : outcome.change,
      },
      history,
    );
  }

  /** After a download that succeeded. */
  protected abstract visited(
    revisit: Revisit & { readonly outcome: Change },
    history: History | null,
  ): Schedule<History>;
}
