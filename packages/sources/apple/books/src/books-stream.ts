import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import type { BooksStore } from '@workspace/sdk-apple-books';

import type { BooksScan } from './books-scan.ts';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;

// A time as a record holds it.
export const iso = (date: Date | null): string | null =>
  date?.toISOString() ?? null;

// Bytes as a record holds them.
export const base64 = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString('base64');

export const booksFields = {
  id: { ...text, minLength: 1 },
  nullableId: { ...nullableText, minLength: 1 },
  text,
  nullableText,
  integer,
  nullableInteger,
  nullableNumber: { type: ['number', 'null'] },
  boolean: { type: 'boolean' },
  nullableBoolean: { type: ['boolean', 'null'] },
  timestamp: { ...text, format: 'date-time' },
  nullableTimestamp: { ...nullableText, format: 'date-time' },
  date: { ...text, format: 'date' },
  assetId: {
    ...text,
    minLength: 1,
    description:
      'Books asset identifier (a 32-character hex string for books added from files); refers to libraryAssets.assetId within this source.',
  },
} as const;

// What the source needs from any Books stream, whatever its record type.
export type BooksReader = {
  readonly name: string;
  readonly store: BooksStore;
  describe(): Stream;
  read(scan: BooksScan): AsyncIterable<Record<string, unknown>>;
  file(
    record: Record<string, unknown>,
    scan: BooksScan,
    staging: string,
  ): Promise<string | null>;
};

// A Books stream: its description, the store it reads, and how its records
// come out of a run's scan. Reading is the same for every stream — read one
// row, project it, validate it against the schema, then read the next, so a
// pass holds one row however large the store — so streams supply only the
// rows and the projection.
export abstract class BooksStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly store: BooksStore;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  abstract readonly primaryKey: readonly string[];
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  async *read(scan: BooksScan): AsyncGenerator<SchemaRecord<P>> {
    for await (const row of this.rows(scan))
      yield* validateRecords(this, [this.record(row, scan)], 'Books');
  }

  // The file a record carries, for streams that support file reads, staged
  // under staging when it has to be built.
  async file(
    _record: SchemaRecord<P>,
    _scan: BooksScan,
    _staging: string,
  ): Promise<string | null> {
    return null;
  }

  protected abstract rows(scan: BooksScan): Iterable<Row> | AsyncIterable<Row>;

  protected abstract record(row: Row, scan: BooksScan): RecordDraft<P>;
}
