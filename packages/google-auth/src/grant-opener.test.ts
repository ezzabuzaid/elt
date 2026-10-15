import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { GoogleOAuthApp } from './app.ts';
import type { GoogleOAuthCredential } from './credential.ts';
import { GoogleGrantMissingError, GoogleGrantRevokedError } from './errors.ts';
import { GoogleGrantOpener } from './grant-opener.ts';
import type { GoogleGrantStore } from './grant-store.ts';
import { GoogleGrant } from './grant.ts';

const APP = new GoogleOAuthApp({
  clientId: 'client-id',
  clientSecret: 'app-secret',
});
const REF = 'google-data-grants/u/accounts/a.json';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const RESOURCE_URL = 'https://api.example/resource';

const SEARCH_CONSOLE = 'https://www.googleapis.com/auth/webmasters.readonly';
const HEALTH = 'https://www.googleapis.com/auth/googlehealth.sleep.readonly';
const STORED: GoogleOAuthCredential = {
  clientId: 'client-id',
  kind: 'GOOGLE_BIGQUERY_OAUTH',
  refreshToken: 'refresh-token',
  scope: `openid email ${SEARCH_CONSOLE} ${HEALTH}`,
};

/**
 * A store over a Map that counts reads and can be told to refuse writes.
 * google-auth-library reaches the token endpoint through node-fetch, so the
 * Google side is stubbed below fetch with msw; anything unlisted fails the
 * test instead of reaching the network.
 */
function mapStore(initial?: GoogleOAuthCredential) {
  const rows = new Map<string, unknown>();
  if (initial) rows.set(REF, initial);
  const calls = { reads: 0, writes: 0 };
  let refuseWrites: Error | undefined;
  const store: GoogleGrantStore = {
    async read(ref) {
      calls.reads += 1;
      return rows.get(ref);
    },
    async write(ref, credential) {
      calls.writes += 1;
      if (refuseWrites) throw refuseWrites;
      rows.set(ref, credential);
    },
  };
  return {
    calls,
    refuseWrites(error: Error) {
      refuseWrites = error;
    },
    rows,
    store,
  };
}

// Each entry answers one refresh: an access token, or an access token with
// the refresh token Google rotates to.
type Refresh = string | { readonly token: string; readonly rotated: string };

function googleServer(
  tokens: readonly Refresh[],
  resourceHits: string[],
  refusal: Record<string, string> = {
    error: 'invalid_grant',
    error_description: 'Token has been expired or revoked.',
  },
  tokenRequests: URLSearchParams[] = [],
) {
  let served = 0;
  return setupServer(
    http.post(TOKEN_URL, async ({ request }) => {
      tokenRequests.push(new URLSearchParams(await request.text()));
      const refresh = tokens[served];
      served += 1;
      if (!refresh) return HttpResponse.json(refusal, { status: 400 });
      return HttpResponse.json(
        typeof refresh === 'string'
          ? { access_token: refresh, expires_in: 3600 }
          : {
              access_token: refresh.token,
              expires_in: 3600,
              refresh_token: refresh.rotated,
            },
      );
    }),
    http.get(RESOURCE_URL, ({ request }) => {
      resourceHits.push(request.headers.get('authorization') ?? '');
      return HttpResponse.json({ ok: true });
    }),
  );
}

function stored(rows: Map<string, unknown>): GoogleOAuthCredential {
  const grant = GoogleGrant.parse(rows.get(REF));
  assert.ok(grant);
  return grant.credential;
}

test('open reads the grant once and refreshes a token for the session scopes only', async () => {
  const tokenRequests: URLSearchParams[] = [];
  const server = googleServer(['fresh'], [], undefined, tokenRequests);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const session = await opener.open(REF, [HEALTH]);

    assert.equal(calls.reads, 1);
    assert.equal(tokenRequests.length, 1);
    assert.equal(tokenRequests[0]?.get('scope'), HEALTH);
    assert.equal(tokenRequests[0]?.get('refresh_token'), 'refresh-token');
    assert.equal(tokenRequests[0]?.get('client_secret'), 'app-secret');
    assert.equal(session.client.credentials.access_token, 'fresh');
    // Without a rotation there is nothing to persist.
    assert.equal(calls.writes, 0);
  } finally {
    server.close();
  }
});

test('a rotated refresh token is persisted with every scope the grant holds before open resolves', async () => {
  const server = googleServer(
    [{ rotated: 'refresh-rotated', token: 'fresh' }],
    [],
  );
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, rows, store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await opener.open(REF, [HEALTH]);

    assert.equal(calls.writes, 1);
    assert.deepEqual(stored(rows), {
      ...STORED,
      refreshToken: 'refresh-rotated',
    });
  } finally {
    server.close();
  }
});

test('a later rotation is persisted before the response that caused it returns', async () => {
  const resourceHits: string[] = [];
  const server = googleServer(
    ['first', { rotated: 'refresh-rotated', token: 'second' }],
    resourceHits,
  );
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, rows, store } = mapStore(STORED);
  // The store finishes a write only when the test lets it.
  const written = Promise.withResolvers<void>();
  const held: GoogleGrantStore = {
    read: (ref) => store.read(ref),
    async write(ref, credential) {
      await written.promise;
      await store.write(ref, credential);
    },
  };
  try {
    const opener = new GoogleGrantOpener({ app: APP, store: held });
    const session = await opener.open(REF, [SEARCH_CONSOLE]);
    session.client.credentials.expiry_date = 1;

    let returned = false;
    const request = session.client
      .request({ url: RESOURCE_URL })
      .finally(() => {
        returned = true;
      });
    while (resourceHits.length === 0) await setImmediate();
    await setImmediate();
    const beforeWrite = returned;
    written.resolve();
    const { data } = await request;

    assert.equal(beforeWrite, false, 'the response waited for the write');
    assert.deepEqual(data, { ok: true });
    assert.deepEqual(resourceHits, ['Bearer second']);
    assert.equal(calls.writes, 1);
    assert.equal(stored(rows).refreshToken, 'refresh-rotated');
  } finally {
    server.close();
  }
});

test('a persist failure rejects the request that rotated and every later one', async () => {
  const server = googleServer(
    [
      'first',
      { rotated: 'refresh-rotated', token: 'second' },
      { rotated: 'refresh-again', token: 'third' },
    ],
    [],
  );
  server.listen({ onUnhandledRequest: 'error' });
  const { refuseWrites, store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });
    const session = await opener.open(REF, [SEARCH_CONSOLE]);
    const diskFull = new Error('ENOSPC');
    refuseWrites(diskFull);
    session.client.credentials.expiry_date = 1;

    await assert.rejects(
      session.client.request({ url: RESOURCE_URL }),
      diskFull,
    );
    // The chain stays broken: the stored refresh token is unknown from here on.
    await assert.rejects(
      session.client.request({ url: RESOURCE_URL }),
      diskFull,
    );
  } finally {
    server.close();
  }
});

test('a grant Google will not refresh is reported as revoked and never written', async () => {
  const server = googleServer([], []);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(
      opener.open(REF, [SEARCH_CONSOLE]),
      GoogleGrantRevokedError,
    );
    assert.equal(calls.writes, 0);
  } finally {
    server.close();
  }
});

test('a missing or malformed grant names its ref', async () => {
  const server = googleServer([], []);
  server.listen({ onUnhandledRequest: 'error' });
  const { rows, store } = mapStore();
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(
      opener.open(REF, [SEARCH_CONSOLE]),
      (error: unknown) => {
        assert.ok(error instanceof GoogleGrantMissingError);
        assert.equal(error.ref, REF);
        return true;
      },
    );
    rows.set(REF, { password: 'not-a-grant' });
    await assert.rejects(
      opener.open(REF, [SEARCH_CONSOLE]),
      GoogleGrantMissingError,
    );
  } finally {
    server.close();
  }
});

test('concurrent opens of one ref and scope set share a single read and refresh', async () => {
  const tokenRequests: URLSearchParams[] = [];
  const server = googleServer(['fresh', 'later'], [], undefined, tokenRequests);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const [first, second] = await Promise.all([
      opener.open(REF, [SEARCH_CONSOLE]),
      opener.open(REF, [SEARCH_CONSOLE]),
    ]);

    assert.equal(first, second);
    assert.equal(calls.reads, 1);
    assert.equal(tokenRequests.length, 1);
    // The in-flight entry is gone: a later open reads and refreshes again.
    const later = await opener.open(REF, [SEARCH_CONSOLE]);
    assert.notEqual(later, first);
    assert.equal(calls.reads, 2);
    assert.equal(tokenRequests.length, 2);
  } finally {
    server.close();
  }
});

test('concurrent opens with different scopes never share a session or a token', async () => {
  const tokenRequests: URLSearchParams[] = [];
  const server = googleServer(['one', 'two'], [], undefined, tokenRequests);
  server.listen({ onUnhandledRequest: 'error' });
  const { store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const [health, searchConsole] = await Promise.all([
      opener.open(REF, [HEALTH]),
      opener.open(REF, [SEARCH_CONSOLE]),
    ]);

    assert.notEqual(health, searchConsole);
    assert.notEqual(
      health.client.credentials.access_token,
      searchConsole.client.credentials.access_token,
    );
    assert.deepEqual(
      tokenRequests.map((body) => body.get('scope')).sort(),
      [HEALTH, SEARCH_CONSOLE].sort(),
    );
  } finally {
    server.close();
  }
});

test('the re-authentication refusal counts as revoked too', async () => {
  const server = googleServer([], [], {
    error: 'invalid_grant',
    error_description: 'reauth related error (invalid_rapt)',
  });
  server.listen({ onUnhandledRequest: 'error' });
  const { store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(
      opener.open(REF, [SEARCH_CONSOLE]),
      GoogleGrantRevokedError,
    );
  } finally {
    server.close();
  }
});

test('other token-endpoint refusals pass through unchanged', async () => {
  const server = googleServer([], [], { error: 'invalid_client' });
  server.listen({ onUnhandledRequest: 'error' });
  const { store } = mapStore(STORED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(opener.open(REF, [SEARCH_CONSOLE]), {
      message: 'invalid_client',
    });
  } finally {
    server.close();
  }
});
