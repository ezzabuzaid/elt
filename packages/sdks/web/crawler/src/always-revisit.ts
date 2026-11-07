import { z } from 'zod';

import { IntervalRevisit } from './interval-revisit.ts';
import type { Schedule } from './revisit-policy.ts';

/**
 * Every URL is due in every crawl, failed and gone ones too. A URL that a
 * download read has no due time of its own, so a watch does not wake for it:
 * a run, or another URL that is due, starts the crawl. A failed or gone URL
 * is due as with every IntervalRevisit, so a watch tries it again.
 */
export class AlwaysRevisit extends IntervalRevisit<null> {
  readonly histories = z.null();

  protected visited(): Schedule<null> {
    return { due: null, history: null };
  }

  override due(): boolean {
    return true;
  }
}
