import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpServer } from '@zukhruf/testing/http';
import { OAuth2Client } from 'google-auth-library';

import { GoogleGrantRevokedError, googleFailureType } from './index.ts';

// The error of a real client for one answer of Google.
async function refusal(status: number, reason: string): Promise<unknown> {
  await using google = await new HttpServer().start((_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: { code: status, errors: [{ reason }], message: reason },
      }),
    );
  });
  const oauth = new OAuth2Client({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  });
  oauth.setCredentials({
    access_token: 'fake-access-token',
    expiry_date: Date.now() + 3_600_000,
  });
  try {
    await oauth.request({ url: `${google.origin}/sites` });
  } catch (error) {
    return error;
  }
  return assert.fail(`Google answered ${status} and the request resolved`);
}

test('a 401 is for the user to fix', async () => {
  assert.equal(googleFailureType(await refusal(401, 'authError')), 'config');
});

test('a 403 that refuses access is for the user to fix', async () => {
  assert.equal(
    googleFailureType(await refusal(403, 'insufficientPermissions')),
    'config',
  );
});

test('a 403 rate limit is not for the user to fix', async () => {
  assert.equal(
    googleFailureType(await refusal(403, 'userRateLimitExceeded')),
    'system',
  );
  assert.equal(
    googleFailureType(await refusal(403, 'rateLimitExceeded')),
    'system',
  );
});

test('a 429 is not for the user to fix', async () => {
  assert.equal(
    googleFailureType(await refusal(429, 'rateLimitExceeded')),
    'system',
  );
});

test('a 500 is not for the user to fix', async () => {
  assert.equal(googleFailureType(await refusal(500, 'backendError')), 'system');
});

test('a revoked grant is for the user to fix', () => {
  assert.equal(
    googleFailureType(
      new GoogleGrantRevokedError({
        clientId: 'client-id',
        kind: 'GOOGLE_BIGQUERY_OAUTH',
        refreshToken: 'fake-refresh-token',
        scope: 'openid',
      }),
    ),
    'config',
  );
});

test('an error that is not an answer of Google is not for the user to fix', () => {
  assert.equal(googleFailureType(new Error('disk full')), 'system');
  assert.equal(googleFailureType('disk full'), 'system');
});

test('an error whose cause is the answer of Google is judged by that answer', async () => {
  assert.equal(
    googleFailureType(
      new Error('Google answered 403 for the attachment', {
        cause: await refusal(403, 'accessNotConfigured'),
      }),
    ),
    'config',
  );
  assert.equal(
    googleFailureType(
      new Error('Google answered 403 for the attachment', {
        cause: await refusal(403, 'userRateLimitExceeded'),
      }),
    ),
    'system',
  );
});
