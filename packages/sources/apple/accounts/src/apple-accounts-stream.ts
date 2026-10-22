import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { AccountsScan } from './accounts-scan.ts';

export const accountsFields = {
  ...eventKitFields,
  nullableId: { type: ['string', 'null'], minLength: 1 },
  nullableBoolean: { type: ['boolean', 'null'] },
  nullableInteger: { type: ['integer', 'null'] },
  strings: { type: 'array', items: { type: 'string' } },
} as const;

// What the source needs from any Accounts stream, whatever its record type.
export type AccountsReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: AccountsScan): Iterable<Record<string, unknown>>;
};

// An Accounts stream: its description, and how its records come out of a
// run's scan. Reading is the same for every stream — pick the rows, project
// each, validate against the schema — so streams supply only those two steps.
export abstract class AppleAccountsStream<P extends Properties, Row> {
  abstract readonly name: string;
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

  // One row at a time, so a pass never holds a whole table's records.
  *read(scan: AccountsScan): Generator<SchemaRecord<P>> {
    for (const row of this.rows(scan))
      yield* validateRecords(this, this.records(row), 'Accounts');
  }

  protected abstract rows(scan: AccountsScan): Iterable<Row>;

  protected abstract records(row: Row): RecordDraft<P>[];
}
