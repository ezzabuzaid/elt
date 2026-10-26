import { z } from 'zod';

import type { CrawlRequest } from './reader.ts';
import {
  type Known,
  type Revisit,
  RevisitPolicy,
  type Schedule,
} from './revisit-policy.ts';

const historySchema = z.object({
  // Which policy keeps this history: an index into the routes, or their length for the fallback.
  route: z.number().int().nonnegative(),
  history: z.unknown(),
});
type History = z.infer<typeof historySchema>;

/**
 * A URL follows the policy of the first route whose pattern matches it, or
 * the fallback: for example FixedRevisit for a website's feed and
 * AdaptiveRevisit for its articles. A URL whose route changes starts the new
 * policy with no history.
 */
export class CompositeRevisit extends RevisitPolicy<History> {
  readonly histories = historySchema;
  readonly #policies: readonly RevisitPolicy<unknown>[];
  readonly #patterns: readonly URLPattern[];

  constructor(
    routes: readonly (readonly [URLPattern, RevisitPolicy<unknown>])[],
    fallback: RevisitPolicy<unknown>,
  ) {
    super();
    this.#patterns = routes.map(([pattern]) => pattern);
    this.#policies = [...routes.map(([, policy]) => policy), fallback];
  }

  schedule(revisit: Revisit, history: History | null): Schedule<History> {
    const { route, policy, own } = this.#route(revisit.request, history);
    const schedule = policy.schedule(revisit, own);
    return { due: schedule.due, history: { route, history: schedule.history } };
  }

  override due(
    request: CrawlRequest,
    known: Known<History>,
    at: number,
  ): boolean {
    const { policy, own } = this.#route(request, known.history);
    return policy.due(request, { ...known, history: own }, at);
  }

  #route(request: CrawlRequest, history: History | null) {
    const index = this.#patterns.findIndex((pattern) =>
      pattern.test(request.url),
    );
    const route = index === -1 ? this.#patterns.length : index;
    const policy = this.#policies[route];
    if (policy === undefined) throw new RangeError(`No revisit route ${route}`);
    return {
      route,
      policy,
      own:
        history?.route === route
          ? policy.histories.nullable().parse(history.history)
          : null,
    };
  }
}
