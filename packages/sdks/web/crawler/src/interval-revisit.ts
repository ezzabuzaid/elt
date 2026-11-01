import {
  type Change,
  type Revisit,
  RevisitPolicy,
  type Schedule,
  day,
  hour,
} from './revisit-policy.ts';

/**
 * A policy that waits a fixed time after a failed or gone visit and decides
 * only the interval after a download that succeeded, as Nutch's
 * AbstractFetchSchedule.
 */
export abstract class IntervalRevisit<History> extends RevisitPolicy<History> {
  /** How long a failed URL waits, as StormCrawler's fetchInterval.fetch.error. */
  protected readonly retryAfter: number = 2 * hour;
  /**
   * How long a gone URL waits. A listing can still name a page that answers
   * 404 and comes back later, so it is asked again, as Nutch's
   * setPageGoneSchedule does, not never, as StormCrawler's default does.
   */
  protected readonly goneAfter: number = day;

  schedule(revisit: Revisit, history: History | null): Schedule<History> {
    if (revisit.outcome === 'failed')
      return { due: revisit.at + this.retryAfter, history };
    if (revisit.outcome === 'gone')
      return { due: revisit.at + this.goneAfter, history };
    // A redirect is a visit that succeeded, as Nutch's CrawlDbReducer gives
    // STATUS_FETCH_REDIR_TEMP and _PERM to setFetchSchedule with a fetched
    // page; its target decides whether it changed.
    const { outcome } = revisit;
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
