import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// A browser profile with a cookie store.
export type ChromiumProfile = {
  // The profile's folder name, such as Default or Profile 5.
  readonly name: string;
  readonly cookies: string;
};

// A Chromium browser on macOS: the folder under Application Support that
// holds its profiles, and the login keychain item that holds the password
// its cookies are encrypted with.
export class ChromiumBrowser {
  readonly name: string;
  readonly folder: string;
  readonly service: string;
  readonly account: string;

  constructor(name: string, folder: string, service: string, account: string) {
    this.name = name;
    this.folder = folder;
    this.service = service;
    this.account = account;
  }

  // Read when asked, so a profile made after the module loaded is found.
  profiles(): ChromiumProfile[] {
    const root = join(homedir(), 'Library/Application Support', this.folder);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, entry.name, 'Cookies')),
      )
      .map((entry) => ({
        name: entry.name,
        cookies: join(root, entry.name, 'Cookies'),
      }));
  }
}

export const chromiumBrowsers: readonly ChromiumBrowser[] = [
  new ChromiumBrowser('Dia', 'Dia/User Data', 'Dia Safe Storage', 'Dia'),
  new ChromiumBrowser(
    'Google Chrome',
    'Google/Chrome',
    'Chrome Safe Storage',
    'Chrome',
  ),
  new ChromiumBrowser('Arc', 'Arc/User Data', 'Arc Safe Storage', 'Arc'),
  new ChromiumBrowser(
    'Microsoft Edge',
    'Microsoft Edge',
    'Microsoft Edge Safe Storage',
    'Microsoft Edge',
  ),
  new ChromiumBrowser(
    'Brave',
    'BraveSoftware/Brave-Browser',
    'Brave Safe Storage',
    'Brave',
  ),
];
