import assert from 'node:assert/strict';
import { test } from 'node:test';

import { http } from 'msw';
import { setupServer } from 'msw/node';

import {
  GaxiosError,
  GoogleGrant,
  GoogleOAuthApp,
} from '@workspace/google-auth';

import { SearchConsoleApi, SearchConsoleQuotaError } from './index.ts';

// A real OAuth client over a stored grant: its first call mints an access
// token at the token endpoint the test's server answers.
function signedIn() {
  return new GoogleOAuthApp({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  }).client(
    new GoogleGrant({
      kind: 'GOOGLE_BIGQUERY_OAUTH',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    }),
    ['https://www.googleapis.com/auth/webmasters.readonly'],
  );
}

/**
 * Google's side of the wire for one test, stubbed below fetch with msw. Each
 * Search Console call is answered with what `reply` returns, a JSON body or a
 * whole Response. Any other request fails the test.
 */
function google({ reply }: { reply: () => unknown }) {
  const calls: string[] = [];
  const server = setupServer(
    http.post('https://oauth2.googleapis.com/token', () =>
      Response.json({ access_token: 'access-token', expires_in: 3600 }),
    ),
    http.all('https://searchconsole.googleapis.com/*', ({ request }) => {
      calls.push(new URL(request.url).pathname);
      const answer = reply();
      return answer instanceof Response ? answer : Response.json(answer);
    }),
  );
  server.listen({ onUnhandledFrame: 'error' });
  return {
    calls,
    requester: signedIn(),
    [Symbol.dispose]: () => server.close(),
  };
}

// An error as Google's APIs answer one.
function refusal(
  status: number,
  reason: string,
  message: string,
  headers?: HeadersInit,
) {
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [{ message, domain: 'global', reason }],
      },
    },
    { status, headers },
  );
}

// Sent with every refusal the policy retries, so the real default policy
// retries at once instead of backing off for seconds. Live, the daily quota's
// 429 carries no Retry-After.
const RETRY_NOW = { 'retry-after': '0' };

// Live, an exhausted daily quota answers 429 rateLimitExceeded with this
// message.
const quotaExceeded = () =>
  refusal(
    429,
    'rateLimitExceeded',
    'Quota exceeded for sc-domain:example.com.',
    RETRY_NOW,
  );
const serverError = () =>
  refusal(500, 'backendError', 'Internal error encountered.', RETRY_NOW);

test('a rate limit waits for the Retry-After the server asks for', async () => {
  let served = 0;
  using searchConsole = google({
    reply: () =>
      served++ === 0
        ? refusal(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
            'retry-after': '1',
          })
        : { siteEntry: [] },
  });
  const started = performance.now();

  assert.deepEqual(
    await new SearchConsoleApi(searchConsole.requester).sites(),
    { siteEntry: [] },
  );
  assert.equal(searchConsole.calls.length, 2);
  assert.ok(performance.now() - started >= 950, 'waited the requested second');
});

test('a Retry-After longer than a minute fails without waiting', async () => {
  using searchConsole = google({
    reply: () =>
      refusal(429, 'rateLimitExceeded', 'Rate Limit Exceeded', {
        'retry-after': '120',
      }),
  });
  const started = performance.now();

  await assert.rejects(
    new SearchConsoleApi(searchConsole.requester).sites(),
    (error: unknown) => {
      assert.ok(error instanceof SearchConsoleQuotaError);
      assert.equal(error.attempts, 1);
      return true;
    },
  );
  assert.equal(searchConsole.calls.length, 1);
  assert.ok(performance.now() - started < 500);
});

test('rate limits that never clear end after five attempts and say so', async () => {
  using searchConsole = google({ reply: () => quotaExceeded() });

  await assert.rejects(
    new SearchConsoleApi(searchConsole.requester).sites(),
    (error: unknown) => {
      assert.ok(error instanceof SearchConsoleQuotaError);
      assert.equal(error.status, 429);
      assert.equal(error.attempts, 5);
      return true;
    },
  );
  assert.equal(searchConsole.calls.length, 5);
});

test('a rate-limit 403 is retried but a scope 403 is not', async () => {
  const replies = [
    () =>
      refusal(
        403,
        'userRateLimitExceeded',
        'User Rate Limit Exceeded',
        RETRY_NOW,
      ),
    () => ({ siteEntry: [] }),
    // The same status Google uses for a missing scope or a disabled API.
    () =>
      refusal(
        403,
        'insufficientPermissions',
        'Request had insufficient authentication scopes.',
      ),
  ];
  let served = 0;
  using searchConsole = google({ reply: () => replies[served++]?.() });
  const api = new SearchConsoleApi(searchConsole.requester);

  assert.deepEqual(await api.sites(), { siteEntry: [] });
  assert.equal(searchConsole.calls.length, 2);
  await assert.rejects(api.sites(), (error: unknown) => {
    assert.ok(error instanceof GaxiosError);
    assert.equal(error.status, 403);
    assert.equal(
      error.message,
      'Request had insufficient authentication scopes.',
    );
    return true;
  });
  assert.equal(searchConsole.calls.length, 3);
});

test('a server error is retried, and one that persists passes through as Google sent it', async () => {
  let failing = false;
  let served = 0;
  using searchConsole = google({
    reply: () => {
      served += 1;
      if (failing) return serverError();
      return served === 1
        ? refusal(
            503,
            'backendError',
            'The service is currently unavailable.',
            RETRY_NOW,
          )
        : { siteEntry: [] };
    },
  });
  const api = new SearchConsoleApi(searchConsole.requester);

  assert.deepEqual(await api.sites(), { siteEntry: [] });
  assert.equal(searchConsole.calls.length, 2);
  failing = true;
  await assert.rejects(api.sites(), (error: unknown) => {
    assert.ok(error instanceof GaxiosError);
    assert.equal(error.status, 500);
    assert.equal(error.message, 'Internal error encountered.');
    return true;
  });
  assert.equal(searchConsole.calls.length, 7);
});
