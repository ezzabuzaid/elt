import { join } from 'node:path';

import {
  type ChromiumBrowser,
  type ChromiumProfile,
  chromiumBrowsers,
} from '@workspace/sdk-chromium-browser';

import { CookieStore } from './cookie-store.ts';
import { BrowserSessionNotFoundError } from './errors.ts';
import { safeStorageKey } from './safe-storage.ts';

// A site's session in a browser profile: the cookies that profile sends to
// the site, decrypted.
export class BrowserSession {
  readonly browser: string;
  readonly profile: string;
  readonly cookies: ReadonlyMap<string, string>;

  private constructor(
    browser: string,
    profile: string,
    cookies: ReadonlyMap<string, string>,
  ) {
    this.browser = browser;
    this.profile = profile;
    this.cookies = cookies;
  }

  // The session of the profile, in any Chromium browser, whose sign-in
  // cookie for url expires last, so the session the user signed in to most
  // recently wins over an older one. Only that browser's key is read. home
  // is the user's home folder, which holds the profiles and the keychain.
  static async newest(
    url: string,
    cookie: string,
    { home }: { home: string },
  ): Promise<BrowserSession> {
    const target = new URL(url);
    let newest: {
      browser: ChromiumBrowser;
      profile: ChromiumProfile;
      expires: bigint;
    } | null = null;
    for (const browser of chromiumBrowsers)
      for (const profile of browser.profiles(home, 'Cookies')) {
        using store = new CookieStore(join(profile.path, 'Cookies'));
        const expires = store.expiry(target, cookie);
        if (expires !== null && (newest === null || expires > newest.expires))
          newest = { browser, profile, expires };
      }
    if (newest === null)
      throw new BrowserSessionNotFoundError(
        target.hostname,
        cookie,
        chromiumBrowsers
          .filter((browser) => browser.profiles(home, 'Cookies').length > 0)
          .map(({ name }) => name),
      );
    const key = await safeStorageKey(newest.browser, home);
    using store = new CookieStore(join(newest.profile.path, 'Cookies'));
    return new BrowserSession(
      newest.browser.name,
      newest.profile.folder,
      store.cookies(target, key, newest.browser.name),
    );
  }
}
