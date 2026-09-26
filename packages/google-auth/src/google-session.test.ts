import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';

import { LoginTicket, OAuth2Client } from 'google-auth-library';

import {
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  GrantFiles,
  googleSession,
  listenForCallback,
  OAuthCallbackTimeoutError,
} from './index.ts';

test('a grant file is owner-only, lands whole, and reads back', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-grant-'));
  const files = new GrantFiles(scratch.path);
  const ref = 'google/user/accounts/account.json';

  assert.equal(await files.read(ref), undefined);
  await files.write(ref, { credentialRef: 'google/user/accounts/a.json' });

  assert.deepEqual(await files.read(ref), {
    credentialRef: 'google/user/accounts/a.json',
  });
  assert.equal((await stat(join(scratch.path, ref))).mode & 0o777, 0o600);
  // The temporary file a write stages through is gone once it lands.
  assert.deepEqual(await readdir(join(scratch.path, 'google/user/accounts')), [
    'account.json',
  ]);
  await files.remove(ref);
  assert.equal(await files.read(ref), undefined);
  await assert.rejects(
    files.write('../outside.json', { credentialRef: 'x' }),
    /escapes the grant directory/,
  );
});

test('the loopback listener settles only on the redirect carrying its state', async () => {
  using listener = await listenForCallback();
  const answered = listener.callback('expected-state');

  const stray = await fetch(`${listener.redirectUri}?code=c&state=other`);
  assert.equal(stray.status, 400);
  assert.equal(
    (await fetch(new URL('/favicon.ico', listener.redirectUri))).status,
    404,
  );

  const redirect = `${listener.redirectUri}?code=c&state=expected-state`;
  const page = await fetch(redirect);
  assert.match(await page.text(), /Signed in/);
  assert.equal(await answered, redirect);
});

test('a refused consent still settles the listener so the flow can report it', async () => {
  using listener = await listenForCallback();
  const answered = listener.callback('state-1');

  const redirect = `${listener.redirectUri}?error=access_denied&state=state-1`;
  assert.match(await (await fetch(redirect)).text(), /Sign-in failed/);
  assert.equal(await answered, redirect);
});

test('a listener nobody answers times out and closes', async () => {
  using listener = await listenForCallback({ timeoutMs: 20 });

  await assert.rejects(
    listener.callback('state-1'),
    (error: unknown) => error instanceof OAuthCallbackTimeoutError,
  );
  await assert.rejects(fetch(listener.redirectUri));
});

function answerGoogle(t: TestContext, scope: string | (() => string)): void {
  t.mock.method(OAuth2Client.prototype, 'getToken', async () => ({
    res: null,
    tokens: {
      access_token: 'fresh',
      expiry_date: 2_000_000_000_000,
      id_token: 'id-token',
      refresh_token: 'refresh',
      scope: typeof scope === 'string' ? scope : scope(),
    },
  }));
  t.mock.method(
    OAuth2Client.prototype,
    'verifyIdToken',
    async () =>
      new LoginTicket('id-token', {
        aud: 'client-id',
        email: 'owner@example.com',
        exp: 2_000_000_000,
        iat: 1_900_000_000,
        iss: 'https://accounts.google.com',
        sub: 'google-1',
      }),
  );
}

// Plays the browser: reads where Google would redirect and with which state.
function browser() {
  const opened: string[] = [];
  return {
    opened,
    async open(url: string) {
      opened.push(url);
      const consent = new URL(url);
      const redirect = new URL(
        String(consent.searchParams.get('redirect_uri')),
      );
      redirect.searchParams.set('code', 'authorization-code');
      redirect.searchParams.set(
        'state',
        String(consent.searchParams.get('state')),
      );
      await fetch(redirect);
    },
  };
}

const client = { clientId: 'client-id', clientSecret: 'client-secret' };

test('the first session runs consent and stores the grant; the next reuses it', async (t) => {
  answerGoogle(t, `openid email ${GOOGLE_SEARCH_CONSOLE_SCOPE}`);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-session-'));
  const chrome = browser();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: chrome.open,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };

  const requester = await googleSession(options);
  assert.equal(typeof requester.request, 'function');
  assert.equal(chrome.opened.length, 1);
  const consent = new URL(String(chrome.opened[0]));
  assert.match(
    String(consent.searchParams.get('redirect_uri')),
    /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
  );
  assert.match(
    String(consent.searchParams.get('scope')),
    /webmasters\.readonly/,
  );

  const [user] = await readdir(join(scratch.path, 'google'));
  const accounts = join(scratch.path, 'google', String(user), 'accounts');
  const [account] = await readdir(accounts);
  assert.equal(
    (await stat(join(accounts, String(account)))).mode & 0o777,
    0o600,
  );

  await googleSession(options);
  assert.equal(chrome.opened.length, 1, 'the stored grant is reused');
});

test('a grant that lacks a newly needed scope asks for consent again', async (t) => {
  const analytics = 'https://www.googleapis.com/auth/analytics.readonly';
  // Google grants what the consent asked for, so the first grant lacks it.
  let granted = `openid email ${GOOGLE_SEARCH_CONSOLE_SCOPE}`;
  answerGoogle(t, () => granted);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-upgrade-'));
  const chrome = browser();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: chrome.open,
  };

  await googleSession({ ...options, scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE] });
  granted = `${granted} ${analytics}`;
  await googleSession({
    ...options,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE, analytics],
  });

  assert.equal(chrome.opened.length, 2);
  // Re-consent asks for the union, so the scope already granted is kept.
  const second = String(
    new URL(String(chrome.opened[1])).searchParams.get('scope'),
  );
  assert.match(second, /webmasters\.readonly/);
  assert.match(second, /analytics\.readonly/);
});

test('a grant Google no longer honors is replaced through consent', async (t) => {
  answerGoogle(t, `openid email ${GOOGLE_SEARCH_CONSOLE_SCOPE}`);
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-revoked-'));
  const chrome = browser();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: chrome.open,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };
  await googleSession(options);

  // Google refuses the stored refresh token once, as it does after revocation.
  let refusals = 1;
  t.mock.method(OAuth2Client.prototype, 'getAccessToken', async () => {
    if (refusals-- > 0) throw new Error('invalid_grant');
    return { res: null, token: 'fresh' };
  });
  await googleSession(options);

  assert.equal(chrome.opened.length, 2);
});
