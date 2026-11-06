import { Gauge } from '@zukhruf/async';

import { ChromiumBookmarks } from '@workspace/sdk-chromium-bookmarks';
import type { ChromiumBrowser } from '@workspace/sdk-chromium-browser';
import { chromiumHistoryVersion } from '@workspace/sdk-chromium-history';

// The History of each selected profile and its version: a commit to one, and
// a profile that gains or loses one, change it.
export class HistoryGauge extends Gauge<string> implements Disposable {
  readonly store = 'history';
  readonly #files: () => string[];
  readonly #versions = new DisposableStack();
  readonly #histories = new Map<
    string,
    ReturnType<typeof chromiumHistoryVersion>
  >();

  constructor(files: () => string[]) {
    super();
    this.#files = files;
  }

  protected async read(): Promise<string> {
    return this.#files()
      .map((path) => `${path}:${this.#version(path).current}`)
      .join();
  }

  [Symbol.dispose](): void {
    this.#versions.dispose();
  }

  #version(path: string): ReturnType<typeof chromiumHistoryVersion> {
    let version = this.#histories.get(path);
    if (version === undefined) {
      version = this.#versions.use(chromiumHistoryVersion(path));
      this.#histories.set(path, version);
    }
    return version;
  }
}

// The file stamp of each selected profile's Bookmarks, which the browser
// replaces whole.
export class BookmarksGauge extends Gauge<string> {
  readonly store = 'bookmarks';
  readonly #files: () => string[];

  constructor(files: () => string[]) {
    super();
    this.#files = files;
  }

  protected async read(): Promise<string> {
    return (
      await Promise.all(
        this.#files().map(async (path) =>
          String(await ChromiumBookmarks.stamp(path)),
        ),
      )
    ).join();
  }
}

// The file stamp of Local State, which names the profiles, and the History
// and Bookmarks files the profiles have.
export class ProfilesGauge extends Gauge<string> {
  readonly store = 'profiles';
  readonly #browser: ChromiumBrowser;
  readonly #home: string;
  readonly #files: () => string[];

  constructor(browser: ChromiumBrowser, home: string, files: () => string[]) {
    super();
    this.#browser = browser;
    this.#home = home;
    this.#files = files;
  }

  protected async read(): Promise<string> {
    return [
      String(await this.#browser.localStateStamp(this.#home)),
      ...this.#files(),
    ].join();
  }
}
