import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BrowserSession,
  BrowserSessionNotFoundError,
  CookieDecryptionError,
  SafeStorageUnavailableError,
} from './index.ts';
import { type ScratchCookie, ScratchMac } from './test/scratch-mac.ts';

type Cookie = ScratchCookie;

// The SDK finds browser profiles under HOME: a test points it at its
// scratch Mac until the test ends.
function home(path: string): Disposable {
  const previous = process.env.HOME;
  process.env.HOME = path;
  return {
    [Symbol.dispose]() {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    },
  };
}

test('a session holds the cookies a browser profile sends to a site, decrypted with its key from the login keychain', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  const password = randomUUID();
  mac.safeStorage('Dia Safe Storage', 'Dia', password);
  mac.cookies('Dia/User Data/Default', password, [
    {
      host: '.instagram.com',
      name: 'sessionid',
      value: '1691%3Aabc',
      days: 300,
    },
    { host: '.instagram.com', name: 'csrftoken', value: 'token', days: 300 },
    { host: '.example.com', name: 'tracker', value: 'other', days: 300 },
  ]);

  const session = await BrowserSession.newest(
    'https://www.instagram.com/',
    'sessionid',
  );

  assert.equal(session.browser, 'Dia');
  assert.equal(session.profile, 'Default');
  assert.deepEqual(Object.fromEntries(session.cookies), {
    csrftoken: 'token',
    sessionid: '1691%3Aabc',
  });
});

test('a cookie whose plaintext is signed for another host is refused, not returned garbled', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  const password = randomUUID();
  mac.safeStorage('Dia Safe Storage', 'Dia', password);
  mac.cookies('Dia/User Data/Default', password, [
    {
      host: '.instagram.com',
      name: 'sessionid',
      value: 'moved',
      days: 300,
      signedFor: '.example.com',
    },
  ]);

  await assert.rejects(
    BrowserSession.newest('https://www.instagram.com/', 'sessionid'),
    (error) =>
      error instanceof CookieDecryptionError &&
      /Dia's sessionid cookie for \.instagram\.com could not be decrypted/.test(
        error.message,
      ),
  );
});

test('the profile whose sign-in cookie expires last wins, and only the winning browser is asked for its key', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  const password = randomUUID();
  mac.safeStorage('Arc Safe Storage', 'Arc', password);
  const session = (value: string, days: number): Cookie => ({
    host: '.instagram.com',
    name: 'sessionid',
    value,
    days,
  });
  // Dia is checked before Arc, so the first session found is the older one.
  mac.cookies('Dia/User Data/Default', randomUUID(), [session('older', 100)]);
  mac.cookies('Arc/User Data/Default', password, [session('newest', 300)]);
  // Neither Dia nor Chrome keeps a Safe Storage item here: reading their keys would fail.
  mac.cookies('Google/Chrome/Default', randomUUID(), [session('chrome', 50)]);

  const newest = await BrowserSession.newest(
    'https://www.instagram.com/',
    'sessionid',
  );

  assert.equal(newest.browser, 'Arc');
  assert.equal(newest.profile, 'Default');
  assert.equal(newest.cookies.get('sessionid'), 'newest');
});

test('a cookie set for the exact host wins over the domain’s of the same name, and a cookie without expiry is sent', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  const password = randomUUID();
  mac.safeStorage('Dia Safe Storage', 'Dia', password);
  mac.cookies('Dia/User Data/Default', password, [
    { host: '.instagram.com', name: 'sessionid', value: 'domain', days: 300 },
    { host: 'www.instagram.com', name: 'sessionid', value: 'host', days: 300 },
    { host: '.instagram.com', name: 'wd', value: '1440x900', days: null },
  ]);

  const session = await BrowserSession.newest(
    'https://www.instagram.com/',
    'sessionid',
  );

  assert.deepEqual(Object.fromEntries(session.cookies), {
    sessionid: 'host',
    wd: '1440x900',
  });
});

test('a browser with only an expired session is named when no session is found', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  mac.cookies('Arc/User Data/Default', randomUUID(), [
    { host: '.instagram.com', name: 'sessionid', value: 'old', days: -10 },
  ]);

  await assert.rejects(
    BrowserSession.newest('https://www.instagram.com/', 'sessionid'),
    (error) =>
      error instanceof BrowserSessionNotFoundError &&
      error.message ===
        'No browser profile holds an unexpired sessionid cookie for www.instagram.com. Sign in to www.instagram.com in Arc, then sync again.',
  );
});

test('a browser whose Safe Storage item the keychain does not give fails with the item to allow', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  mac.cookies('Dia/User Data/Default', randomUUID(), [
    { host: '.instagram.com', name: 'sessionid', value: 's', days: 300 },
  ]);

  await assert.rejects(
    BrowserSession.newest('https://www.instagram.com/', 'sessionid'),
    (error) =>
      error instanceof SafeStorageUnavailableError &&
      error.browser === 'Dia' &&
      /Allow access when macOS asks for "Dia Safe Storage"/.test(error.message),
  );
});

test('a read while the browser commits its cookies waits for the commit instead of failing', async () => {
  await using mac = await ScratchMac.create();
  using _home = home(mac.path);
  const password = randomUUID();
  mac.safeStorage('Dia Safe Storage', 'Dia', password);
  mac.cookies('Dia/User Data/Default', password, [
    { host: '.instagram.com', name: 'sessionid', value: 's', days: 300 },
  ]);
  const store = join(
    mac.path,
    'Library/Application Support/Dia/User Data/Default/Cookies',
  );
  // Another process takes the database's exclusive lock, as the browser does
  // while it commits, and commits a second later.
  const browser = spawn(process.execPath, [
    '-e',
    `const { DatabaseSync } = require('node:sqlite');
     const db = new DatabaseSync(process.argv[1]);
     db.exec('BEGIN EXCLUSIVE');
     process.stdout.write('locked');
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
     db.exec('COMMIT');`,
    store,
  ]);
  try {
    await new Promise((resolve) => browser.stdout.once('data', resolve));

    const session = await BrowserSession.newest(
      'https://www.instagram.com/',
      'sessionid',
    );

    assert.equal(session.cookies.get('sessionid'), 's');
  } finally {
    browser.kill();
  }
});
