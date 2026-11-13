import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { UnavailableError } from '@zukhruf/sqlite-data-version';

import {
  type AppDatabaseVersion,
  StoreUnavailableError,
} from '@eltjs/sdk-macos-app-database';

import { appDatabase, biomeStore } from './app-database.ts';
import { type BiomeSegment, segments } from './biome-segment.ts';
import type { BiomeStream } from './biome-stream.ts';
import { BiomeSync } from './biome-sync.ts';

// The user's Biome in the home folder `home`, where macOS keeps activity
// for this Mac and the devices it syncs with. The system Biome under
// /private/var/db/biome is _biome's.
export const biomeDirectory = (home: string): string =>
  join(home, 'Library/Biome');

// The folder of every stream, known to be readable: without that check a
// missing or denied folder would list every stream as empty. Any other
// failure to list it fails as itself.
export class BiomeStreams {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  segments<E>(stream: BiomeStream<E>): Promise<BiomeSegment<E>[]> {
    return segments(this.#path, stream);
  }
}

export class BiomeStore {
  readonly #streams: string;
  readonly #sync: string;

  constructor(root: string) {
    this.#streams = join(root, 'streams/restricted');
    this.#sync = join(root, 'sync/sync.db');
  }

  async streams(): Promise<BiomeStreams> {
    try {
      await readdir(this.#streams);
    } catch (cause) {
      const unavailable = UnavailableError.from(this.#streams, cause);
      if (unavailable === undefined) throw cause;
      throw new StoreUnavailableError(biomeStore, this.#streams, unavailable);
    }
    return new BiomeStreams(this.#streams);
  }

  // The device list in one snapshot. Hold it only while reading: an open read
  // stops Biome checkpointing the database's WAL.
  sync(): BiomeSync {
    return new BiomeSync(this.#sync);
  }

  // What changes when a stream does: its segment listing and each segment's
  // fingerprint. FSEvents reports nothing, since Biome writes in place.
  async version(stream: BiomeStream<unknown>): Promise<string> {
    const found = await segments(this.#streams, stream);
    return (
      await Promise.all(
        found.map(
          async (segment) =>
            `${segment.origin}/${segment.name}=${await segment.fingerprint()}`,
        ),
      )
    ).join('|');
  }

  // Biome commits the device list through a WAL it keeps open.
  syncVersion(): AppDatabaseVersion {
    return appDatabase.version(this.#sync);
  }
}
