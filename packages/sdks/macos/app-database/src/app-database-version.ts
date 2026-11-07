import { Gauge } from '@zukhruf/async';
import {
  type DataVersion,
  UnavailableError,
} from '@zukhruf/sqlite-data-version';

// What a change watcher reads of one store of an app. It opens the database
// at its first read, and again after the store was unavailable: a store that
// is not there, or that this process cannot open, reads as unavailable. Its
// appearance is thus a change, and the read of its streams reports why (elt
// ADR 0020).
export class AppDatabaseVersion
  extends Gauge<number | 'unavailable'>
  implements Disposable
{
  #state: VersionState;

  // open makes the DataVersion of the owner's kind.
  constructor(open: () => DataVersion) {
    super();
    this.#state = new Closed(open);
  }

  get current(): number | 'unavailable' {
    const { value, state } = this.#state.read();
    this.#state = state;
    return value;
  }

  protected async read(): Promise<number | 'unavailable'> {
    return this.current;
  }

  [Symbol.dispose](): void {
    this.#state[Symbol.dispose]();
  }
}

type VersionRead = {
  readonly value: number | 'unavailable';
  readonly state: VersionState;
};

interface VersionState extends Disposable {
  read(): VersionRead;
}

// Each read tries to open the database; the first that can reads it open.
class Closed implements VersionState {
  readonly #open: () => DataVersion;

  constructor(open: () => DataVersion) {
    this.#open = open;
  }

  read(): VersionRead {
    // A database that fails its first read closes, and the next read opens
    // it again.
    using opened = new DisposableStack();
    let version: DataVersion;
    try {
      version = opened.use(this.#open());
    } catch (error) {
      if (error instanceof UnavailableError)
        return { value: 'unavailable', state: this };
      throw error;
    }
    const read = new Opened(this.#open, version).read();
    opened.move();
    return read;
  }

  // Nothing is open.
  [Symbol.dispose](): void {}
}

// A store that the owner replaced with one this process cannot open is
// unavailable again, until a readable one is back.
class Opened implements VersionState {
  readonly #open: () => DataVersion;
  readonly #version: DataVersion;

  constructor(open: () => DataVersion, version: DataVersion) {
    this.#open = open;
    this.#version = version;
  }

  read(): VersionRead {
    try {
      return { value: this.#version.current, state: this };
    } catch (error) {
      if (!(error instanceof UnavailableError)) throw error;
      this.#version[Symbol.dispose]();
      return { value: 'unavailable', state: new Closed(this.#open) };
    }
  }

  [Symbol.dispose](): void {
    this.#version[Symbol.dispose]();
  }
}
