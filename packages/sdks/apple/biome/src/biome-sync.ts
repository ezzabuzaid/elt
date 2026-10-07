import type { SQLOutputValue } from 'node:sqlite';

import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { BiomeSchemaError, BiomeUnavailableError } from './errors.ts';

// A device Biome syncs activity with, this Mac included.
export type BiomeDevice = {
  // What origin names in the device's segments.
  readonly id: string | undefined;
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
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, BiomeUnavailableError);
    this.#database.requireColumns(columns, BiomeSchemaError);
  }

  devices(): BiomeDevice[] {
    return this.#database
      .all(
        'SELECT device_identifier, me, name, CAST(model AS TEXT) AS model, platform, last_sync_date FROM DevicePeer ORDER BY device_identifier',
      )
      .map((row) => ({
        id:
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
