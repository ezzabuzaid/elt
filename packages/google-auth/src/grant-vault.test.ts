import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import type { GoogleDataGrantCredential } from './credential.ts';
import { GoogleAccountGrant } from './grant.ts';
import type { GoogleGrantVaultStore } from './grant-store.ts';
import { GoogleGrantVault } from './grant-vault.ts';

const DIRECTORY = 'google-data-grants';

function credential(accountId: string): GoogleDataGrantCredential {
  return {
    accessToken: `token-${accountId}`,
    clientId: 'client-id',
    expiresAt: 1,
    googleAccountEmail: `${accountId}@acme.example`,
    googleAccountId: accountId,
    kind: 'GOOGLE_BIGQUERY_OAUTH',
    refreshToken: `refresh-${accountId}`,
    scope: 'openid email',
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function mapStore() {
  const rows = new Map<string, unknown>();
  const writes: string[] = [];
  const removed: string[] = [];
  const store: GoogleGrantVaultStore = {
    async read(ref) {
      return rows.get(ref);
    },
    async write(ref, value) {
      writes.push(ref);
      rows.set(ref, value);
    },
    async remove(ref) {
      removed.push(ref);
      rows.delete(ref);
    },
  };
  return { removed, rows, store, writes };
}

test('a user with no grant has no active grant, and nothing is written', async () => {
  const { store, writes } = mapStore();
  const vault = new GoogleGrantVault({ directory: DIRECTORY, store });

  assert.equal(await vault.active('user-1'), undefined);
  assert.deepEqual(writes, []);
});

test('save makes the grant active for that user only', async () => {
  const { store } = mapStore();
  const vault = new GoogleGrantVault({ directory: DIRECTORY, store });

  const ref = await vault.save(
    'user-1',
    new GoogleAccountGrant(credential('acc-1')),
  );

  assert.equal(
    ref,
    `${DIRECTORY}/${sha256('user-1')}/accounts/${sha256('acc-1')}.json`,
  );
  const active = await vault.active('user-1');
  assert.equal(active?.ref, ref);
  assert.deepEqual(active?.grant.account, {
    email: 'acc-1@acme.example',
    id: 'acc-1',
  });
  assert.equal(await vault.active('user-2'), undefined);
});

test('the grant file is written before the pointer that names it', async () => {
  const { store, writes } = mapStore();
  const vault = new GoogleGrantVault({ directory: DIRECTORY, store });

  const ref = await vault.save(
    'user-1',
    new GoogleAccountGrant(credential('acc-1')),
  );

  assert.deepEqual(writes, [
    ref,
    `${DIRECTORY}/${sha256('user-1')}/active.json`,
  ]);
});

test('saving the same account again overwrites its one file', async () => {
  const { rows, store } = mapStore();
  const vault = new GoogleGrantVault({ directory: DIRECTORY, store });

  const first = await vault.save(
    'user-1',
    new GoogleAccountGrant(credential('acc-1')),
  );
  const second = await vault.save(
    'user-1',
    new GoogleAccountGrant({ ...credential('acc-1'), accessToken: 'newer' }),
  );

  assert.equal(first, second);
  assert.equal(rows.size, 2);
  assert.equal(
    (await vault.active('user-1'))?.grant.credential.accessToken,
    'newer',
  );
});

test('a pointer to a missing grant file is removed and reads as no grant', async () => {
  const { removed, rows, store } = mapStore();
  const vault = new GoogleGrantVault({ directory: DIRECTORY, store });
  const activeRef = `${DIRECTORY}/${sha256('user-1')}/active.json`;
  rows.set(activeRef, {
    credentialRef: `${DIRECTORY}/${sha256('user-1')}/accounts/gone.json`,
  });

  assert.equal(await vault.active('user-1'), undefined);
  assert.deepEqual(removed, [activeRef]);
  assert.equal(rows.has(activeRef), false);
});

test('a pointer or grant the app did not write is an error, not a repair', async () => {
  const { rows, store } = mapStore();
  const vault = new GoogleGrantVault({ directory: DIRECTORY, store });
  const userDirectory = `${DIRECTORY}/${sha256('user-1')}`;
  const selectionError = {
    message: 'Stored Google grant selection has an invalid shape',
  };

  rows.set(`${userDirectory}/active.json`, { ref: 'wrong-key' });
  await assert.rejects(vault.active('user-1'), selectionError);

  rows.set(`${userDirectory}/active.json`, {
    credentialRef: `${DIRECTORY}/${sha256('user-2')}/accounts/x.json`,
  });
  await assert.rejects(vault.active('user-1'), selectionError);

  const ref = `${userDirectory}/accounts/x.json`;
  rows.set(`${userDirectory}/active.json`, { credentialRef: ref });
  rows.set(ref, { password: 'not-a-grant' });
  await assert.rejects(vault.active('user-1'), {
    message: 'Stored Google grant has an invalid shape',
  });
});
