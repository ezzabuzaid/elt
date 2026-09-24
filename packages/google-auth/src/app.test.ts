import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LoginTicket, OAuth2Client } from 'google-auth-library';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';

import { GoogleOAuthApp } from './app.ts';
import type { GoogleOAuthCredential } from './credential.ts';
import { GoogleGrant } from './grant.ts';
import type { GoogleRequester } from './requester.ts';
import { GOOGLE_BIGQUERY_SCOPE } from './scopes.ts';

const APP = new GoogleOAuthApp({
  clientId: 'client-id',
  clientSecret: 'client-secret',
});
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

const CREDENTIAL: GoogleOAuthCredential = {
  accessToken: 'access-token',
  clientId: 'client-id',
  expiresAt: 1,
  kind: 'GOOGLE_BIGQUERY_OAUTH',
  refreshToken: 'refresh-token',
  scope: 'openid email',
};

test('the client over a grant satisfies the requester contract', () => {
  // The annotation is the assertion: this file stops compiling the day
  // `OAuth2Client.request` stops fitting, which is the only way a product
  // module could silently diverge from every stub it is tested with.
  const client = APP.client(new GoogleGrant(CREDENTIAL));
  const requester: GoogleRequester = client;

  assert.ok(client instanceof OAuth2Client);
  assert.equal(typeof requester.request, 'function');
  assert.equal(client.credentials.access_token, 'access-token');
});

test('accepts the canonical Google email scope', async (t) => {
  const redirectUri = 'http://127.0.0.1:49152/oauth/callback';
  const { flow, url } = await APP.authorize(
    redirectUri,
    [GOOGLE_BIGQUERY_SCOPE],
    { kind: 'initial' },
  );
  const state = new URL(url).searchParams.get('state');
  assert.ok(state);

  t.mock.method(OAuth2Client.prototype, 'getToken', async () => ({
    res: null,
    tokens: {
      access_token: 'access-token',
      expiry_date: 2_000_000_000_000,
      id_token: 'id-token',
      refresh_token: 'refresh-token',
      scope: `openid https://www.googleapis.com/auth/userinfo.email ${GOOGLE_BIGQUERY_SCOPE}`,
    },
  }));
  t.mock.method(
    OAuth2Client.prototype,
    'verifyIdToken',
    async () =>
      new LoginTicket('id-token', {
        aud: 'client-id',
        email: 'person@example.test',
        exp: 2_000_000_000,
        iat: 1_900_000_000,
        iss: 'https://accounts.google.com',
        sub: 'google-account-id',
      }),
  );

  const { grant, idToken } = await APP.complete(
    `${redirectUri}?code=authorization-code&state=${state}`,
    flow,
  );

  assert.deepEqual(grant.credential, {
    accessToken: 'access-token',
    clientId: 'client-id',
    expiresAt: 2_000_000_000_000,
    googleAccountEmail: 'person@example.test',
    googleAccountId: 'google-account-id',
    kind: 'GOOGLE_BIGQUERY_OAUTH',
    refreshToken: 'refresh-token',
    scope: `openid https://www.googleapis.com/auth/userinfo.email ${GOOGLE_BIGQUERY_SCOPE}`,
  });
  assert.equal(idToken, 'id-token');
  assert.deepEqual(grant.account, {
    email: 'person@example.test',
    id: 'google-account-id',
  });
});

test('the consent URL asks for identity plus the data scopes, once each', async () => {
  const { url } = await APP.authorize(
    'http://127.0.0.1:49152/oauth/callback',
    [GOOGLE_BIGQUERY_SCOPE, GOOGLE_BIGQUERY_SCOPE],
    { kind: 'select' },
  );
  const params = new URL(url).searchParams;

  assert.equal(
    params.get('scope'),
    `openid email profile ${GOOGLE_BIGQUERY_SCOPE}`,
  );
  assert.equal(params.get('prompt'), 'consent select_account');
  assert.equal(params.get('access_type'), 'offline');
  assert.equal(params.get('code_challenge_method'), 'S256');
});

test('a grant without a refresh token is refused', async (t) => {
  const redirectUri = 'http://127.0.0.1:49152/oauth/callback';
  const { flow, url } = await APP.authorize(
    redirectUri,
    [GOOGLE_BIGQUERY_SCOPE],
    { kind: 'initial' },
  );
  const state = new URL(url).searchParams.get('state');
  t.mock.method(OAuth2Client.prototype, 'getToken', async () => ({
    res: null,
    tokens: {
      access_token: 'access-token',
      expiry_date: 2_000_000_000_000,
      id_token: 'id-token',
      scope: 'openid email',
    },
  }));

  await assert.rejects(
    APP.complete(`${redirectUri}?code=authorization-code&state=${state}`, flow),
    /durable authorization/,
  );
});

test('revoke hands the refresh token to Google and skips an imported grant', async () => {
  const revoked: (string | null)[] = [];
  const server = setupServer(
    http.post(REVOKE_URL, ({ request }) => {
      revoked.push(new URL(request.url).searchParams.get('token'));
      return HttpResponse.json({});
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
  try {
    await APP.revoke(new GoogleGrant(CREDENTIAL));
    // No request may leave for the imported grant: `onUnhandledRequest` is
    // not the proof here, the recorded list is.
    await APP.revoke(
      new GoogleGrant({
        ...CREDENTIAL,
        clientSecret: 'gcloud-secret',
        externallyManaged: true,
      }),
    );

    assert.deepEqual(revoked, ['refresh-token']);
  } finally {
    server.close();
  }
});
