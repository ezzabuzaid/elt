import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { OAuth2Client } from 'google-auth-library';

import { GaxiosError, isRateLimit } from './index.ts';

// A real client with an access token that has not expired, so a request goes
// straight to the server.
function signedIn(): OAuth2Client {
  const oauth = new OAuth2Client({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  oauth.setCredentials({
    access_token: 'fake-access-token',
    expiry_date: Date.now() + 3_600_000,
  });
  return oauth;
}

// The error of a real client for one answer of Google, with the reason in the
// legacy `errors` list or, as APIs on the newer error model send it, in an
// ErrorInfo detail.
async function refusal(
  status: number,
  reason: string,
  where: 'errors' | 'details' = 'errors',
): Promise<unknown> {
  await using google = await new HttpServer().start((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          code: status,
          message: reason,
          [where]: [
            where === 'errors'
              ? { reason }
              : { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason },
          ],
        },
      }),
    );
  });
  try {
    await signedIn().request({ url: `${google.origin}/sites` });
  } catch (error) {
    return error;
  }
  return assert.fail(`Google answered ${status} and the request resolved`);
}

test('a 403 that refuses access is not a rate limit', async () => {
  assert.equal(
    isRateLimit(await refusal(403, 'insufficientPermissions')),
    false,
  );
  assert.equal(isRateLimit(await refusal(403, 'accessNotConfigured')), false);
});

test('an error that carries no answer of Google is not a rate limit', async () => {
  // A real client's error for a server that closed: a GaxiosError with no
  // response.
  const closed = await new HttpServer().start((_request, response) =>
    response.end(),
  );
  await closed.cleanup();
  const unreachable = await signedIn()
    .request({ url: `${closed.origin}/sites` })
    .then(
      () => assert.fail('a closed server answered'),
      (error: unknown) => error,
    );
  assert.ok(unreachable instanceof GaxiosError, String(unreachable));
  assert.equal(unreachable.response, undefined);
  assert.equal(isRateLimit(unreachable), false);

  assert.equal(isRateLimit(new Error('rateLimitExceeded')), false);
  assert.equal(
    isRateLimit(
      new TypeError('fetch failed', { cause: new Error('ECONNRESET') }),
    ),
    false,
  );
  assert.equal(isRateLimit(undefined), false);
});

test('the reasons a caller gives take the place of the usual two', async () => {
  assert.equal(
    isRateLimit(await refusal(403, 'RESOURCE_EXHAUSTED', 'details'), [
      'RESOURCE_EXHAUSTED',
    ]),
    true,
  );
  assert.equal(
    isRateLimit(await refusal(403, 'rateLimitExceeded'), [
      'RESOURCE_EXHAUSTED',
    ]),
    false,
  );
});

test('a 429 is a rate limit whatever reason it names', async () => {
  assert.equal(isRateLimit(await refusal(429, 'quotaExceeded')), true);
  assert.equal(
    isRateLimit(await refusal(429, 'rateLimitExceeded'), [
      'RESOURCE_EXHAUSTED',
    ]),
    true,
  );
});

test('a 403 that names a usual rate-limit reason is a rate limit', async () => {
  assert.equal(isRateLimit(await refusal(403, 'rateLimitExceeded')), true);
  assert.equal(isRateLimit(await refusal(403, 'userRateLimitExceeded')), true);
});
