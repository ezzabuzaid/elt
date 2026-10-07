import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AppDatabase,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

import { KnowledgeSchemaError, KnowledgeUnavailableError } from './errors.ts';
import type {
  KnowledgeColumns,
  KnowledgeStream,
  KnowledgeTable,
} from './knowledge-stream.ts';
import { appleDate, integer, text } from './knowledge-values.ts';

// CoreDuet's knowledge store, the older activity store that still records
// what Biome does not.
export const knowledgeStorePath = join(
  homedir(),
  'Library/Application Support/Knowledge/knowledgeC.db',
);

// What every event carries.
export type KnowledgeEvent = {
  // ZOBJECT.ZUUID.
  readonly id: string | undefined;
  readonly startedAt: Date | undefined;
  readonly endedAt: Date | undefined;
  // When knowledgeC stored the event.
  readonly createdAt: Date | undefined;
  // The device's offset from UTC when the event happened.
  readonly utcOffsetSeconds: number | undefined;
};

// Each table an event row joins, by the alias the query gives it.
const tables: readonly { name: KnowledgeTable; alias: string }[] = [
  { name: 'ZOBJECT', alias: 'o' },
  { name: 'ZSTRUCTUREDMETADATA', alias: 'm' },
  { name: 'ZSOURCE', alias: 's' },
];

const eventColumns: KnowledgeColumns = {
  ZOBJECT: [
    'ZUUID',
    'ZSTARTDATE',
    'ZENDDATE',
    'ZCREATIONDATE',
    'ZSECONDSFROMGMT',
  ],
};

// The columns the query joins, filters and orders by.
const queryColumns: KnowledgeColumns = {
  ZOBJECT: ['Z_PK', 'ZSTREAMNAME', 'ZSTRUCTUREDMETADATA', 'ZSOURCE'],
  ZSTRUCTUREDMETADATA: ['Z_PK'],
  ZSOURCE: ['Z_PK'],
};

const columnsOf = (sets: readonly KnowledgeColumns[], table: KnowledgeTable) =>
  sets.flatMap((set) => set[table] ?? []);

// knowledgeC read in one snapshot. Hold it only while reading: an open read
// stops knowledgeC checkpointing its WAL.
export class KnowledgeSnapshot implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, KnowledgeUnavailableError);
  }

  // A stream's events in the order knowledgeC stored them. Each read checks
  // only the columns it reads, so a layout change fails only the streams it
  // touches.
  events<E>(stream: KnowledgeStream<E>): (KnowledgeEvent & E)[] {
    const missing = this.#database.missingColumns(
      Object.fromEntries(
        tables.map(({ name }) => [
          name,
          columnsOf([queryColumns, eventColumns, stream.columns], name),
        ]),
      ),
    );
    if (missing.length > 0)
      throw new KnowledgeSchemaError(this.#database.path, missing);
    const selected = tables.flatMap(({ name, alias }) =>
      columnsOf([eventColumns, stream.columns], name).map(
        (column) => `${alias}.${column}`,
      ),
    );
    return this.#database
      .all(
        `SELECT ${selected.join(', ')}
         FROM ZOBJECT o
         LEFT JOIN ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA
         LEFT JOIN ZSOURCE s ON s.Z_PK = o.ZSOURCE
         WHERE o.ZSTREAMNAME = ? ORDER BY o.Z_PK`,
        stream.name,
      )
      .map((row) => ({
        id: text(row.ZUUID),
        startedAt: appleDate(row.ZSTARTDATE),
        endedAt: appleDate(row.ZENDDATE),
        createdAt: appleDate(row.ZCREATIONDATE),
        utcOffsetSeconds: integer(row.ZSECONDSFROMGMT),
        ...stream.decode(row),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}

export class KnowledgeStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  open(): KnowledgeSnapshot {
    return new KnowledgeSnapshot(this.#path);
  }

  // knowledgeC commits through a WAL it keeps open.
  version(): AppDatabaseVersion {
    return new AppDatabaseVersion(this.#path, KnowledgeUnavailableError);
  }
}
