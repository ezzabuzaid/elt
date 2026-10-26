import CachePolicy from 'http-cache-semantics';
import { z } from 'zod';

import { IntervalRevisit } from './interval-revisit.ts';
import { type Revisit, type Schedule, day, hour } from './revisit-policy.ts';

const longest = 14 * day;

/**
 * A URL is due when its response stops being fresh, by the freshness
 * lifetime its server declares (RFC 9111: Cache-Control max-age, Expires, or
 * the heuristic from Last-Modified), between one hour and fourteen days. A
 * response that declares nothing is due a day later.
 */
export class HintRevisit extends IntervalRevisit<null> {
  readonly histories = z.null();

  protected visited({ request, headers, at }: Revisit): Schedule<null> {
    const lifetime =
      headers === null
        ? 0
        : new CachePolicy(
            { url: request.url, method: 'GET', headers: {} },
            { status: 200, headers: Object.fromEntries(headers) },
            { shared: false },
          ).timeToLive();
    return {
      due:
        at + (lifetime > 0 ? Math.min(longest, Math.max(hour, lifetime)) : day),
      history: null,
    };
  }
}
