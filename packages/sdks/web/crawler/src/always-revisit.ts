import { z } from 'zod';

import { IntervalRevisit } from './interval-revisit.ts';
import { type Revisit, type Schedule } from './revisit-policy.ts';

/**
 * Every URL is due in every crawl, failed and gone ones too: a full refresh,
 * which must see every page that still exists before it replaces its pages.
 */
export class AlwaysRevisit extends IntervalRevisit<null> {
  readonly histories = z.null();
  protected override readonly retryAfter = 0;
  protected override readonly goneAfter = 0;

  protected visited({ at }: Revisit): Schedule<null> {
    return { due: at, history: null };
  }
}
