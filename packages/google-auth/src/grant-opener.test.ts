import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { GoogleOAuthApp } from './app.ts';
import type { GoogleOAuthCredential } from './credential.ts';
import { GoogleGrantMissingError, GoogleGrantRevokedError } from './errors.ts';
import { GoogleGrant, GoogleImportedGrant } from './grant.ts';
import { GoogleGrantOpener } from './grant-opener.ts';
import type { GoogleGrantStore } from './grant-store.ts';

const APP = new GoogleOAuthApp({
  clientId: 'client-id',
  clientSecret: 'app-secret',
});
const REF = 'google-data-grants/u/accounts/a.json';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const RESOURCE_URL = 'https://api.example/resource';

const EXPIRED: GoogleOAuthCredential = {
  accessToken: 'stale',
  clientId: 'client-id',
  expiresAt: 1,
  kind: 'GOOGLE_BIGQUERY_OAUTH',
  refreshToken: 'refresh-token',
  scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly',
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

function googleServer(
  tokens: readonly string[],
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
      const token = tokens[served];
      served += 1;
      if (!token) return HttpResponse.json(refusal, { status: 400 });
      return HttpResponse.json({ access_token: token, expires_in: 3600 });
    }),
    http.get(RESOURCE_URL, ({ request }) => {
      resourceHits.push(request.headers.get('authorization') ?? '');
      return HttpResponse.json({ ok: true });
    }),
  );
}

function storedAccessToken(rows: Map<string, unknown>): unknown {
  const persisted: unknown = rows.get(REF);
  assert.ok(
    typeof persisted === 'object' &&
      persisted !== null &&
      'accessToken' in persisted,
  );
  return persisted.accessToken;
}

test('open reads the grant once, refreshes it, and persists before resolving', async () => {
  const server = googleServer(['fresh'], []);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, rows, store } = mapStore(EXPIRED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const session = await opener.open(REF);

    assert.equal(calls.reads, 1);
    assert.equal(calls.writes, 1);
    assert.equal(storedAccessToken(rows), 'fresh');
    assert.equal(session.grant.credential.refreshToken, 'refresh-token');
    assert.equal(session.client.credentials.access_token, 'fresh');
  } finally {
    server.close();
  }
});

test('a later refresh is persisted before the response that caused it returns', async () => {
  const resourceHits: string[] = [];
  const server = googleServer(['first', 'second'], resourceHits);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, rows, store } = mapStore(EXPIRED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });
    const session = await opener.open(REF);
    session.client.credentials.expiry_date = 1;

    const { data } = await session.client.request({ url: RESOURCE_URL });

    assert.deepEqual(data, { ok: true });
    assert.deepEqual(resourceHits, ['Bearer second']);
    assert.equal(calls.writes, 2);
    assert.equal(storedAccessToken(rows), 'second');
  } finally {
    server.close();
  }
});

test('a persist failure rejects the request that refreshed and every later one', async () => {
  const server = googleServer(['first', 'second', 'third'], []);
  server.listen({ onUnhandledRequest: 'error' });
  const { refuseWrites, store } = mapStore(EXPIRED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });
    const session = await opener.open(REF);
    const diskFull = new Error('ENOSPC');
    refuseWrites(diskFull);
    session.client.credentials.expiry_date = 1;

    await assert.rejects(
      session.client.request({ url: RESOURCE_URL }),
      diskFull,
    );
    // The chain stays broken: the stored token is unknown from here on.
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
  const { calls, store } = mapStore(EXPIRED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(opener.open(REF), GoogleGrantRevokedError);
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

    await assert.rejects(opener.open(REF), (error: unknown) => {
      assert.ok(error instanceof GoogleGrantMissingError);
      assert.equal(error.ref, REF);
      return true;
    });
    rows.set(REF, { password: 'not-a-grant' });
    await assert.rejects(opener.open(REF), GoogleGrantMissingError);
  } finally {
    server.close();
  }
});

test('concurrent opens of one ref share a single read and refresh', async () => {
  const server = googleServer(['fresh'], []);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, store } = mapStore(EXPIRED);
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const [first, second] = await Promise.all([
      opener.open(REF),
      opener.open(REF),
    ]);

    assert.equal(first, second);
    assert.equal(calls.reads, 1);
    assert.equal(calls.writes, 1);
    // The in-flight entry is gone: a later open reads again, and finds a
    // grant fresh enough to need no refresh.
    const later = await opener.open(REF);
    assert.notEqual(later, first);
    assert.equal(calls.reads, 2);
    assert.equal(calls.writes, 1);
  } finally {
    server.close();
  }
});

test('the re-authentication refusal counts as revoked too', async () => {
  // google-auth-library rewrites the message to the JSON body for this
  // variant, so the code has to be read from the response.
  const server = googleServer([], [], {
    error: 'invalid_grant',
    error_description: 'reauth related error (invalid_rapt)',
  });
  server.listen({ onUnhandledRequest: 'error' });
  const { store } = mapStore();
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(
      opener.transient(new GoogleGrant(EXPIRED)),
      GoogleGrantRevokedError,
    );
  } finally {
    server.close();
  }
});

test('other token-endpoint refusals pass through unchanged', async () => {
  const server = googleServer([], [], { error: 'invalid_client' });
  server.listen({ onUnhandledRequest: 'error' });
  const { store } = mapStore();
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await assert.rejects(opener.transient(new GoogleGrant(EXPIRED)), {
      message: 'invalid_client',
    });
  } finally {
    server.close();
  }
});

test('an imported credential is refreshed with the secret it carries', async () => {
  const tokenRequests: URLSearchParams[] = [];
  const server = googleServer(['a', 'b'], [], undefined, tokenRequests);
  server.listen({ onUnhandledRequest: 'error' });
  const { store } = mapStore();
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    await opener.transient(
      new GoogleGrant({
        ...EXPIRED,
        clientSecret: 'gcloud-secret',
        externallyManaged: true,
      }),
    );
    await opener.transient(new GoogleGrant(EXPIRED));

    assert.deepEqual(
      tokenRequests.map((body) => body.get('client_secret')),
      ['gcloud-secret', 'app-secret'],
    );
  } finally {
    server.close();
  }
});

test('a transient session proves the grant usable and never writes', async () => {
  const server = googleServer(['fresh'], []);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, store } = mapStore();
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const session = await opener.transient(new GoogleGrant(EXPIRED));

    assert.equal(session.client.credentials.access_token, 'fresh');
    assert.equal(calls.reads, 0);
    assert.equal(calls.writes, 0);
  } finally {
    server.close();
  }
});

test('a transient session over an imported grant mints its first token and carries the result', async () => {
  const tokenRequests: URLSearchParams[] = [];
  const server = googleServer(['minted'], [], undefined, tokenRequests);
  server.listen({ onUnhandledRequest: 'error' });
  const { calls, store } = mapStore();
  try {
    const opener = new GoogleGrantOpener({ app: APP, store });

    const session = await opener.transient(
      new GoogleImportedGrant('owner@example.test', {
        clientId: 'gcloud-client',
        clientSecret: 'gcloud-secret',
        externallyManaged: true,
        kind: 'GOOGLE_BIGQUERY_OAUTH',
        refreshToken: 'gcloud-refresh',
        scope: 'https://www.googleapis.com/auth/bigquery',
      }),
    );

    assert.equal(tokenRequests.length, 1);
    assert.equal(tokenRequests[0]?.get('client_secret'), 'gcloud-secret');
    assert.equal(tokenRequests[0]?.get('refresh_token'), 'gcloud-refresh');
    assert.equal(session.grant.credential.accessToken, 'minted');
    assert.equal(session.grant.credential.externallyManaged, true);
    assert.equal(session.grant.credential.clientSecret, 'gcloud-secret');
    assert.ok(session.grant.credential.expiresAt > Date.now());
    assert.equal(calls.writes, 0);
  } finally {
    server.close();
  }
});
