import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { AppFilesVersion } from '@workspace/sdk-macos-app-database';

import { LocalStateFormatError } from './errors.ts';

// A profile folder of a Chromium browser, such as Default or Profile 5.
export type ChromiumProfile = {
  readonly folder: string;
  readonly path: string;
};

// A Chromium browser on macOS: the folder under Application Support that
// holds its profiles and its Local State, the login keychain item that holds
// the password its cookies are encrypted with, and whether it removes old
// history as Chromium does.
export class ChromiumBrowser {
  readonly id: string;
  readonly name: string;
  readonly folder: string;
  readonly service: string;
  readonly account: string;
  // Chromium removes visits older than 90 days. Dia and Arc keep every visit:
  // their expiry never moved past 1971, and on 2026-11-02 Dia held 79,960
  // visits older than 90 days.
  readonly expiresHistory: boolean;

  constructor(browser: {
    id: string;
    name: string;
    folder: string;
    service: string;
    account: string;
    expiresHistory: boolean;
  }) {
    this.id = browser.id;
    this.name = browser.name;
    this.folder = browser.folder;
    this.service = browser.service;
    this.account = browser.account;
    this.expiresHistory = browser.expiresHistory;
  }

  // home is the user's home folder.
  root(home: string): string {
    return join(home, 'Library/Application Support', this.folder);
  }

  // Each profile folder that holds file, such as Cookies or History. Read
  // when asked, so a profile made after the module loaded is found. A browser
  // that is not installed has none.
  profiles(home: string, file: string): ChromiumProfile[] {
    const root = this.root(home);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && existsSync(join(root, entry.name, file)),
      )
      .map((entry) => ({ folder: entry.name, path: join(root, entry.name) }));
  }

  // The name the user gave each profile, by folder, from Local State, the
  // list of profiles the browser keeps. A browser that is not installed has
  // none.
  profileNames(home: string): ReadonlyMap<string, string> {
    const path = this.#localState(home);
    if (!existsSync(path)) return new Map();
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(path, 'utf8'));
    } catch (cause) {
      throw new LocalStateFormatError(path, { cause });
    }
    const cache = profileCache(state);
    if (cache === undefined) throw new LocalStateFormatError(path);
    return new Map(
      Object.entries(cache).flatMap(([folder, profile]) =>
        isNamed(profile) ? [[folder, profile.name]] : [],
      ),
    );
  }

  // Changes when the browser writes Local State, which it replaces whole.
  localStateVersion(home: string): AppFilesVersion {
    return new AppFilesVersion(() => [this.#localState(home)]);
  }

  // Whether the browser runs now. A running browser links SingletonLock in
  // its folder to its host and process id, and leaves the link behind when
  // it crashes; Chromium's ProcessSingleton trusts the link only while that
  // process lives on this host, and so does this check.
  running(home: string): boolean {
    let target: string;
    try {
      target = readlinkSync(join(this.root(home), 'SingletonLock'));
    } catch {
      return false;
    }
    const split = target.lastIndexOf('-');
    const pid = Number(target.slice(split + 1));
    if (target.slice(0, split) !== hostname() || !Number.isSafeInteger(pid))
      return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM: the process lives, but under another user.
      return (
        error instanceof Error && 'code' in error && error.code === 'EPERM'
      );
    }
  }

  #localState(home: string): string {
    return join(this.root(home), 'Local State');
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNamed = (value: unknown): value is { name: string } =>
  isObject(value) && typeof value.name === 'string';

function profileCache(state: unknown): Record<string, unknown> | undefined {
  if (!isObject(state) || !isObject(state.profile)) return undefined;
  const cache = state.profile.info_cache;
  return isObject(cache) ? cache : undefined;
}

export const dia = new ChromiumBrowser({
  id: 'dia',
  name: 'Dia',
  folder: 'Dia/User Data',
  service: 'Dia Safe Storage',
  account: 'Dia',
  expiresHistory: false,
});

export const chrome = new ChromiumBrowser({
  id: 'chrome',
  name: 'Google Chrome',
  folder: 'Google/Chrome',
  service: 'Chrome Safe Storage',
  account: 'Chrome',
  expiresHistory: true,
});

export const arc = new ChromiumBrowser({
  id: 'arc',
  name: 'Arc',
  folder: 'Arc/User Data',
  service: 'Arc Safe Storage',
  account: 'Arc',
  expiresHistory: false,
});

export const edge = new ChromiumBrowser({
  id: 'edge',
  name: 'Microsoft Edge',
  folder: 'Microsoft Edge',
  service: 'Microsoft Edge Safe Storage',
  account: 'Microsoft Edge',
  expiresHistory: true,
});

export const brave = new ChromiumBrowser({
  id: 'brave',
  name: 'Brave',
  folder: 'BraveSoftware/Brave-Browser',
  service: 'Brave Safe Storage',
  account: 'Brave',
  expiresHistory: true,
});

export const chromiumBrowsers: readonly ChromiumBrowser[] = [
  dia,
  chrome,
  arc,
  edge,
  brave,
];
