import { GoogleGrantRevokedError } from './errors.ts';
import { statusOf } from './platform/google/google-errors.ts';
import { isRateLimit } from './rate-limit.ts';

/**
 * Whose failure an answer of Google is. `config`: only the user can fix it,
 * because Google refused the grant (401), refused what the grant may read (a
 * 403 that is not a rate limit) or will no longer refresh the grant.
 * `system`: everything else, which a later run can pass.
 *
 * A caller that adds its own text wraps the answer in an `Error` with
 * `{ cause }`, so an error without a status is judged by its cause.
 */
export function googleFailureType(error: unknown): 'config' | 'system' {
  if (GoogleGrantRevokedError.matches(error)) return 'config';
  const answer =
    statusOf(error) === undefined && Error.isError(error) ? error.cause : error;
  const status = statusOf(answer);
  const refused = status === 401 || (status === 403 && !isRateLimit(answer));
  return refused ? 'config' : 'system';
}
