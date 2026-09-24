import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';

import { LoginTicket, OAuth2Client } from 'google-auth-library';

import { GoogleOAuthApp } from './app.ts';
import { GoogleConsent } from './consent.ts';
import type { GoogleDataGrantCredential } from './credential.ts';
import { GoogleAccountGrant } from './grant.ts';
import type { GoogleGrantVaultStore } from './grant-store.ts';
import { GoogleGrantVault } from './grant-vault.ts';
import { GOOGLE_ANALYTICS_SCOPE, GOOGLE_BIGQUERY_SCOPE } from './scopes.ts';

const APP = new GoogleOAuthApp({
  clientId: 'client-id',
  clientSecret: 'client-secret',
});
const REDIRECT_URI = 'http://127.0.0.1:49152/oauth/callback';
const USER = 'user-1';

const STORED: GoogleDataGrantCredential = {
  accessToken: 'token',
  clientId: 'client-id',
  expiresAt: 1,
  googleAccountEmail: 'owner@acme.example',
  googleAccountId: 'google-1',
  kind: 'GOOGLE_BIGQUERY_OAUTH',
  refreshToken: 'refresh',
  scope: `openid email ${GOOGLE_BIGQUERY_SCOPE}`,
};

function consent(stored?: GoogleDataGrantCredential) {
  const rows = new Map<string, unknown>();
  const store: GoogleGrantVaultStore = {
    async read(ref) {
      return rows.get(ref);
    },
    async write(ref, value) {
      rows.set(ref, value);
    },
    async remove(ref) {
      rows.delete(ref);
    },
  };
  const vault = new GoogleGrantVault({ directory: 'google', store });
  const ready = stored
    ? vault.save(USER, new GoogleAccountGrant(stored))
    : Promise.resolve();
  return { consent: new GoogleConsent({ app: APP, vault }), ready, rows };
}

function answerGoogle(t: TestContext, scope: string): void {
  t.mock.method(OAuth2Client.prototype, 'getToken', async () => ({
    res: null,
    tokens: {
      access_token: 'fresh',
      expiry_date: 2_000_000_000_000,
      id_token: 'id-token',
      refresh_token: 'refresh-2',
      scope,
    },
  }));
  t.mock.method(
    OAuth2Client.prototype,
    'verifyIdToken',
    async () =>
      new LoginTicket('id-token', {
        aud: 'client-id',
        email: 'owner@acme.example',
        exp: 2_000_000_000,
        iat: 1_900_000_000,
        iss: 'https://accounts.google.com',
        sub: 'google-1',
      }),
  );
}

test('current answers only when the grant covers the scopes and the account is kept', async () => {
  const { consent: c, ready } = consent(STORED);
  await ready;

  const kept = await c.current(USER, [GOOGLE_BIGQUERY_SCOPE], {
    differentAccount: false,
  });
  assert.equal(kept?.grant.account.id, 'google-1');
  assert.equal(
    await c.current(USER, [GOOGLE_ANALYTICS_SCOPE], {
      differentAccount: false,
    }),
    undefined,
  );
  assert.equal(
    await c.current(USER, [GOOGLE_BIGQUERY_SCOPE], { differentAccount: true }),
    undefined,
  );
});

test('begin with no grant asks for identity plus the data scopes', async () => {
  const { consent: c } = consent();

  const { ticket, url } = await c.begin(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: false,
    redirectUri: REDIRECT_URI,
  });

  const params = new URL(url).searchParams;
  assert.equal(
    params.get('scope'),
    `openid email profile ${GOOGLE_ANALYTICS_SCOPE}`,
  );
  assert.equal(params.get('prompt'), 'consent');
  assert.equal(params.get('login_hint'), null);
  assert.equal(params.get('state'), ticket.flow.state);
  assert.equal(ticket.userId, USER);
  assert.equal(ticket.flow.redirectUri, REDIRECT_URI);
});

test('begin with a grant that lacks a scope asks for the union and names the account', async () => {
  const { consent: c, ready } = consent(STORED);
  await ready;

  const { url } = await c.begin(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: false,
    redirectUri: REDIRECT_URI,
  });

  const params = new URL(url).searchParams;
  assert.equal(
    params.get('scope'),
    `openid email profile ${GOOGLE_BIGQUERY_SCOPE} ${GOOGLE_ANALYTICS_SCOPE}`,
  );
  assert.equal(params.get('login_hint'), 'google-1');
  assert.equal(params.get('prompt'), 'consent');
});

test('begin for a different account starts from the data scopes and lets the user pick', async () => {
  const { consent: c, ready } = consent(STORED);
  await ready;

  const { url } = await c.begin(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: true,
    redirectUri: REDIRECT_URI,
  });

  const params = new URL(url).searchParams;
  assert.equal(
    params.get('scope'),
    `openid email profile ${GOOGLE_ANALYTICS_SCOPE}`,
  );
  assert.equal(params.get('prompt'), 'consent select_account');
  assert.equal(params.get('login_hint'), null);
});

test('finish saves the grant, makes it active, and the ticket survives JSON', async (t) => {
  const { consent: c, rows } = consent();
  const { ticket, url } = await c.begin(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: false,
    redirectUri: REDIRECT_URI,
  });
  answerGoogle(t, `openid email ${GOOGLE_ANALYTICS_SCOPE}`);
  const state = new URL(url).searchParams.get('state');

  const finished = await c.finish(
    JSON.parse(JSON.stringify(ticket)),
    `${REDIRECT_URI}?code=authorization-code&state=${state}`,
  );

  assert.equal(finished.grant.account.email, 'owner@acme.example');
  assert.equal(finished.grant.credential.accessToken, 'fresh');
  assert.equal(rows.get(finished.ref), finished.grant.credential);
  const current = await c.current(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: false,
  });
  assert.equal(current?.ref, finished.ref);
});

test('a refused consent rejects and writes nothing', async () => {
  const { consent: c, rows } = consent();
  const { ticket } = await c.begin(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: false,
    redirectUri: REDIRECT_URI,
  });

  await assert.rejects(
    c.finish(
      ticket,
      `${REDIRECT_URI}?error=access_denied&state=${ticket.flow.state}`,
    ),
    /Google authorization failed: access_denied/,
  );
  assert.equal(rows.size, 0);
});

test('partial data consent preserves the previous grant', async (t) => {
  const { consent: c, ready, rows } = consent(STORED);
  await ready;
  const before = new Map(rows);
  const { ticket } = await c.begin(USER, [GOOGLE_ANALYTICS_SCOPE], {
    differentAccount: false,
    redirectUri: REDIRECT_URI,
  });
  answerGoogle(t, 'openid email profile');

  await assert.rejects(
    c.finish(ticket, `${REDIRECT_URI}?code=code&state=${ticket.flow.state}`),
    /every requested permission/,
  );
  assert.deepEqual(rows, before);
});
