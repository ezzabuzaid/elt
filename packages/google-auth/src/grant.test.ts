import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GoogleOAuthCredential } from './credential.ts';
import {
  GoogleAccountGrant,
  GoogleGrant,
  GoogleImportedGrant,
} from './grant.ts';

const CREDENTIAL: GoogleOAuthCredential = {
  accessToken: 'token',
  clientId: 'client-id',
  expiresAt: 1,
  kind: 'GOOGLE_BIGQUERY_OAUTH',
  refreshToken: 'refresh-token',
  scope: 'openid  email https://www.googleapis.com/auth/webmasters.readonly',
};

test('parse accepts a stored grant and rejects anything else', () => {
  assert.equal(GoogleGrant.parse(CREDENTIAL)?.credential, CREDENTIAL);
  assert.equal(GoogleGrant.parse({ password: 'x' }), undefined);
  assert.equal(GoogleGrant.parse(undefined), undefined);
  assert.equal(GoogleGrant.parse({ ...CREDENTIAL, kind: 'OTHER' }), undefined);
});

test('covers answers for every requested scope at once', () => {
  const grant = new GoogleGrant(CREDENTIAL);

  assert.deepEqual(
    [...grant.scopes],
    ['openid', 'email', 'https://www.googleapis.com/auth/webmasters.readonly'],
  );
  assert.equal(grant.covers([]), true);
  assert.equal(
    grant.covers(['https://www.googleapis.com/auth/webmasters.readonly']),
    true,
  );
  assert.equal(
    grant.covers([
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/bigquery',
    ]),
    false,
  );
});

test('an account grant is parsed only when the grant names both id and email', () => {
  assert.equal(GoogleAccountGrant.parse(CREDENTIAL), undefined);
  assert.equal(
    GoogleAccountGrant.parse({ ...CREDENTIAL, googleAccountId: 'id-only' }),
    undefined,
  );
  assert.equal(GoogleAccountGrant.parse({ password: 'x' }), undefined);
  const stored = {
    ...CREDENTIAL,
    googleAccountEmail: 'owner@acme.example',
    googleAccountId: 'google-1',
  };
  const grant = GoogleAccountGrant.parse(stored);
  assert.ok(grant instanceof GoogleAccountGrant);
  assert.ok(grant instanceof GoogleGrant);
  assert.equal(grant.credential, stored);
  assert.deepEqual(grant.account, {
    email: 'owner@acme.example',
    id: 'google-1',
  });
});

test('the account is known only when the grant names both id and email', () => {
  assert.equal(new GoogleGrant(CREDENTIAL).account, undefined);
  assert.equal(
    new GoogleGrant({ ...CREDENTIAL, googleAccountId: 'id-only' }).account,
    undefined,
  );
  assert.deepEqual(
    new GoogleGrant({
      ...CREDENTIAL,
      googleAccountEmail: 'owner@acme.example',
      googleAccountId: 'google-1',
    }).account,
    { email: 'owner@acme.example', id: 'google-1' },
  );
});

test('an imported grant is parsed from an authorized_user file with the account it names', () => {
  const file = {
    type: 'authorized_user',
    client_id: ' gcloud-client ',
    client_secret: 'gcloud-secret',
    refresh_token: 'gcloud-refresh',
    account: 'owner@example.test',
  };

  const grant = GoogleImportedGrant.parse(file, {
    account: 'folder@example.test',
    scope: 'https://www.googleapis.com/auth/bigquery',
  });

  assert.equal(grant?.account, 'owner@example.test');
  assert.deepEqual(grant?.credential, {
    clientId: 'gcloud-client',
    clientSecret: 'gcloud-secret',
    externallyManaged: true,
    kind: 'GOOGLE_BIGQUERY_OAUTH',
    refreshToken: 'gcloud-refresh',
    scope: 'https://www.googleapis.com/auth/bigquery',
  });
});

test('an imported grant falls back to the folder account and rejects other files', () => {
  const options = { account: 'folder@example.test', scope: 'scope' };
  const file = {
    type: 'authorized_user',
    client_id: 'c',
    client_secret: 's',
    refresh_token: 'r',
  };

  assert.equal(
    GoogleImportedGrant.parse(file, options)?.account,
    'folder@example.test',
  );
  assert.equal(
    GoogleImportedGrant.parse({ ...file, account: '  ' }, options)?.account,
    'folder@example.test',
  );
  assert.equal(
    GoogleImportedGrant.parse({ ...file, type: 'service_account' }, options),
    undefined,
  );
  assert.equal(
    GoogleImportedGrant.parse({ ...file, refresh_token: '' }, options),
    undefined,
  );
  assert.equal(GoogleImportedGrant.parse(undefined, options), undefined);
});
