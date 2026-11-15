import type { SQLOutputValue } from 'node:sqlite';

import { type Snapshot } from '@zukhruf/sqlite-snapshot';

import { appDatabase } from './app-database.ts';

// A device Biome syncs activity with, this Mac included.
export type BiomeDevice = {
  // The row's rowid: DevicePeer declares no key, so this is the only identity
  // sync.db keeps. A VACUUM can renumber it (ADR 0022).
  readonly id: number;
  // What origin names in the device's segments. sync.db does not keep it
  // unique: two rows can name one device.
  readonly identifier: string | undefined;
  // This Mac, whose segments carry origin 'local'.
  readonly thisMac: boolean;
  // Biome usually leaves the name empty.
  readonly name: string | undefined;
  // An OS build such as 23G90, in a numeric column, so a build that reads as
  // a number arrives mangled.
  readonly model: string | undefined;
  // 2 iPhone, 3 Mac desktop, 4 Mac portable, 5 TV observed.
  readonly platform: number | undefined;
  // Never for this Mac.
  readonly lastSyncedAt: Date | undefined;
};

const columns = {
  DevicePeer: [
    'device_identifier',
    'me',
    'name',
    'model',
    'platform',
    'last_sync_date',
  ],
} as const;

const text = (value: SQLOutputValue | undefined) =>
  typeof value === 'string' && value !== '' ? value : undefined;

// Biome's device list (sync/sync.db), read in one snapshot.
export class BiomeSync implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = appDatabase.snapshot(path, columns);
  }

  // Read as the caller iterates, like every read that feeds a stream.
  devices(): IteratorObject<BiomeDevice, undefined> {
    return this.#database
      .iterate(
        'SELECT rowid, device_identifier, me, name, CAST(model AS TEXT) AS model, platform, last_sync_date FROM DevicePeer ORDER BY rowid',
      )
      .map((row) => ({
        id: Number(row.rowid),
        identifier:
          typeof row.device_identifier === 'string'
            ? row.device_identifier
            : undefined,
        thisMac: row.me === 1,
        name: text(row.name),
        model: text(row.model),
        platform:
          typeof row.platform === 'number' && Number.isSafeInteger(row.platform)
            ? row.platform
            : undefined,
        lastSyncedAt:
          typeof row.last_sync_date === 'number' &&
          Number.isFinite(row.last_sync_date)
            ? new Date(Math.round(row.last_sync_date * 1000))
            : undefined,
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
