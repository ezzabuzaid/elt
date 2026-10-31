import { execFile } from 'node:child_process';
import { pbkdf2Sync } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { ChromiumBrowser } from './chromium-browser.ts';
import { SafeStorageUnavailableError } from './errors.ts';

const run = promisify(execFile);

// The AES key a browser encrypts its cookies with, derived as Chromium does
// from the Safe Storage password in the login keychain. macOS asks the user
// the first time; Always Allow keeps later reads silent. home is the user's
// home folder, which holds the login keychain.
export async function safeStorageKey(
  browser: ChromiumBrowser,
  home: string,
): Promise<Buffer> {
  const keychain = join(home, 'Library/Keychains/login.keychain-db');
  let password: string;
  try {
    const { stdout } = await run('/usr/bin/security', [
      'find-generic-password',
      '-w',
      '-s',
      browser.service,
      '-a',
      browser.account,
      keychain,
    ]);
    password = stdout.replace(/\n$/, '');
  } catch (cause) {
    throw new SafeStorageUnavailableError(browser.name, browser.service, {
      cause,
    });
  }
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}
