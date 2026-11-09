import { type Check, Gauge } from '@zukhruf/async';

import { chromiumHistoryVersion } from '@eltjs/sdk-chromium-history';

// The History of each selected profile and its version: a commit to one, and
// a profile that gains or loses one, change it.
export class HistoryGauge extends Gauge<string> implements Disposable {
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

// The file stamp of Local State, which names the profiles, and the History
// and Bookmarks files the profiles have.
export class ProfilesGauge extends Gauge<readonly string[]> {
  readonly #localState: Gauge<string>;
  readonly #files: () => string[];

  constructor(localState: Gauge<string>, files: () => string[]) {
    super();
    this.#localState = localState;
    this.#files = files;
  }

  protected async read(check: Check): Promise<readonly string[]> {
    return [await this.#localState.value(check), ...this.#files()];
  }
}
