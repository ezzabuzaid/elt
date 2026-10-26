import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempDisposable, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HttpResponse, http, passthrough } from 'msw';
import { setupServer } from 'msw/node';

import {
  GMAIL_READONLY_SCOPE,
  GOOGLE_DRIVE_READONLY_SCOPE,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  GrantFiles,
  OAuthCallbackTimeoutError,
  googleSession,
  listenForCallback,
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

const client = { clientId: 'client-id', clientSecret: 'client-secret' };

const HEALTH_SCOPE =
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly';
const HEALTH_URL = 'https://health.googleapis.com/v4/users/me/identity';
const SITES_URL = 'https://searchconsole.googleapis.com/webmasters/v3/sites';
const IDENTITY_SCOPES = new Set([
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
]);

/**
 * Google as a session meets it, on the wire: the consent page grants what it
 * was asked for, the token endpoint mints tokens that name their scopes and
 * refuses a refresh token it no longer honors, the certs endpoint serves the
 * key the id token is signed with, and two APIs judge a token by its scopes
 * the way the real ones do (Health refuses any scope outside its own, captured
 * live on 2026-10-15).
 */
function googleAccount() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const google: {
    granted: string[];
    honored: string;
    opened: string[];
    refusals: number;
    rotateTo: string | undefined;
  } = {
    granted: [],
    honored: 'refresh-1',
    opened: [],
    refusals: 0,
    rotateTo: undefined,
  };
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = () => {
    const now = Math.floor(Date.now() / 1000);
    const signed = `${encode({ alg: 'RS256', kid: 'key-1', typ: 'JWT' })}.${encode(
      {
        aud: client.clientId,
        email: 'owner@example.com',
        exp: now + 3600,
        iat: now,
        iss: 'https://accounts.google.com',
        sub: 'google-1',
      },
    )}`;
    return `${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
  };
  const token = (scopes: readonly string[]) =>
    `scoped.${Buffer.from(scopes.join(' ')).toString('base64url')}`;
  const scopesOf = (request: Request) =>
    Buffer.from(
      String(request.headers.get('authorization')).replace(
        'Bearer scoped.',
        '',
      ),
      'base64url',
    )
      .toString()
      .split(' ');
  const server = setupServer(
    // The redirect reaches the session's real loopback listener.
    http.get(/^http:\/\/127\.0\.0\.1:\d+\/callback/, () => passthrough()),
    http.get('https://www.googleapis.com/oauth2/v1/certs', () =>
      HttpResponse.json({
        'key-1': publicKey.export({ format: 'pem', type: 'spki' }),
      }),
    ),
    http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get('grant_type') === 'authorization_code')
        return HttpResponse.json({
          access_token: token(google.granted),
          expires_in: 3599,
          id_token: idToken(),
          refresh_token: google.honored,
          scope: google.granted.join(' '),
          token_type: 'Bearer',
        });
      if (body.get('refresh_token') !== google.honored || google.refusals-- > 0)
        return HttpResponse.json(
          {
            error: 'invalid_grant',
            error_description: 'Token has been expired or revoked.',
          },
          { status: 400 },
        );
      const scopes = body.get('scope')?.split(' ') ?? google.granted;
      if (!scopes.every((scope) => google.granted.includes(scope)))
        return HttpResponse.json({ error: 'invalid_scope' }, { status: 400 });
      const rotated = google.rotateTo;
      if (rotated) {
        google.honored = rotated;
        google.rotateTo = undefined;
      }
      return HttpResponse.json({
        access_token: token(scopes),
        expires_in: 3599,
        ...(rotated && { refresh_token: rotated }),
        scope: scopes.join(' '),
        token_type: 'Bearer',
      });
    }),
    http.get(HEALTH_URL, ({ request }) => {
      const disallowed = scopesOf(request).filter(
        (scope) =>
          !scope.includes('googlehealth') && !IDENTITY_SCOPES.has(scope),
      );
      if (disallowed.length > 0)
        return HttpResponse.json(
          {
            error: {
              code: 403,
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                  domain: 'health.googleapis.com',
                  metadata: {
                    disallowed_scopes: disallowed.join(','),
                    unrecognized_scopes_present: 'false',
                  },
                  reason: 'DISALLOWED_OAUTH_SCOPES',
                },
              ],
              message: 'Request contains disallowed OAuth scope(s).',
              status: 'PERMISSION_DENIED',
            },
          },
          { status: 403 },
        );
      return HttpResponse.json({ healthUserId: 'health-1' });
    }),
    http.get(SITES_URL, ({ request }) =>
      scopesOf(request).includes(GOOGLE_SEARCH_CONSOLE_SCOPE)
        ? HttpResponse.json({ siteEntry: [] })
        : HttpResponse.json(
            { error: { code: 403, status: 'PERMISSION_DENIED' } },
            { status: 403 },
          ),
    ),
  );
  server.listen({ onUnhandledFrame: 'error' });
  return {
    google,
    // Plays the browser: Google grants exactly what the consent page asks.
    async openBrowser(url: string) {
      google.opened.push(url);
      const consent = new URL(url);
      google.granted = String(consent.searchParams.get('scope')).split(' ');
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
    [Symbol.dispose]() {
      server.close();
    },
  };
}

test('a session asks Google for a token with only its own scopes, so Health answers on a grant that also holds Drive, Gmail and Search Console', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-narrow-'));
  using account = googleAccount();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: account.openBrowser,
  };
  await googleSession({
    ...options,
    scopes: [GOOGLE_DRIVE_READONLY_SCOPE, GMAIL_READONLY_SCOPE],
  });
  await googleSession({ ...options, scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE] });

  const health = await googleSession({ ...options, scopes: [HEALTH_SCOPE] });
  const { data } = await health.request({ url: HEALTH_URL });

  assert.deepEqual(data, { healthUserId: 'health-1' });
});

test('a failed browser opener rejects consent and closes the callback listener', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-browser-'));
  const failure = new Error('Browser unavailable');
  let redirectUri: string | null = null;
  await assert.rejects(
    googleSession({
      ...client,
      directory: scratch.path,
      scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
      async openBrowser(url) {
        redirectUri = new URL(url).searchParams.get('redirect_uri');
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.ok(redirectUri);
  await assert.rejects(fetch(redirectUri));
});

test('the first session runs consent and stores the grant; the next reuses it', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-session-'));
  using account = googleAccount();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: account.openBrowser,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };

  const requester = await googleSession(options);
  assert.equal(typeof requester.request, 'function');
  assert.equal(account.google.opened.length, 1);
  const consent = new URL(String(account.google.opened[0]));
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
  const [file] = await readdir(accounts);
  assert.equal((await stat(join(accounts, String(file)))).mode & 0o777, 0o600);

  await googleSession(options);
  assert.equal(account.google.opened.length, 1, 'the stored grant is reused');
});

test('a grant that lacks a newly needed scope asks for consent again', async () => {
  const analytics = 'https://www.googleapis.com/auth/analytics.readonly';
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-upgrade-'));
  using account = googleAccount();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: account.openBrowser,
  };

  await googleSession({ ...options, scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE] });
  await googleSession({
    ...options,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE, analytics],
  });

  assert.equal(account.google.opened.length, 2);
  // Re-consent asks for the union, so the scope already granted is kept.
  const second = String(
    new URL(String(account.google.opened[1])).searchParams.get('scope'),
  );
  assert.match(second, /webmasters\.readonly/);
  assert.match(second, /analytics\.readonly/);
});

test('a grant Google no longer honors is replaced through consent', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-revoked-'));
  using account = googleAccount();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: account.openBrowser,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };
  await googleSession(options);

  // Google refuses the stored refresh token once, as it does after revocation.
  account.google.refusals = 1;
  await googleSession(options);

  assert.equal(account.google.opened.length, 2);
});

test('sessions with different scopes reuse one grant without consent, and each calls its API with its own token', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-shared-'));
  using account = googleAccount();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: account.openBrowser,
  };
  await googleSession({ ...options, scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE] });
  await googleSession({ ...options, scopes: [HEALTH_SCOPE] });
  const consents = account.google.opened.length;

  const health = await googleSession({ ...options, scopes: [HEALTH_SCOPE] });
  const searchConsole = await googleSession({
    ...options,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  });
  const sites = await searchConsole.request({ url: SITES_URL });
  const identity = await health.request({ url: HEALTH_URL });

  assert.equal(account.google.opened.length, consents);
  assert.deepEqual(sites.data, { siteEntry: [] });
  assert.deepEqual(identity.data, { healthUserId: 'health-1' });
});

test('a refresh token Google rotates is kept, so the next session refreshes without consent', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'gsc-rotate-'));
  using account = googleAccount();
  const options = {
    ...client,
    directory: scratch.path,
    openBrowser: account.openBrowser,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  };
  account.google.rotateTo = 'refresh-2';
  await googleSession(options);

  const searchConsole = await googleSession(options);
  const { data } = await searchConsole.request({ url: SITES_URL });

  assert.equal(account.google.opened.length, 1);
  assert.deepEqual(data, { siteEntry: [] });
});
