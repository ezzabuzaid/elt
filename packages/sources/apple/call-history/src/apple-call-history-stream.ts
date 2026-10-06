import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { CallHistoryScan } from './call-history-scan.ts';

export const callHistoryFields = {
  ...eventKitFields,
  nullableId: { type: ['string', 'null'], minLength: 1 },
  nullableBoolean: { type: ['boolean', 'null'] },
  nullableInteger: { type: ['integer', 'null'] },
  nullableSeconds: { type: ['number', 'null'], minimum: 0 },
  nullableInstant: {
    type: ['string', 'null'],
    format: 'date-time',
    precision: 6,
  },
} as const;

// What the source needs from any Call History stream, whatever its record
// type.
export type CallHistoryReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: CallHistoryScan): Record<string, unknown>[];
};

// A Call History stream: its description, and how its records come out of a
// run's scan. Reading is the same for every stream — pick the rows, project
// each, validate against the schema — so streams supply only those two steps.
export abstract class AppleCallHistoryStream<P extends Properties, Row> {
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

  read(scan: CallHistoryScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      this.rows(scan).flatMap((row) => this.records(row)),
      'Call History',
    );
  }

  protected abstract rows(scan: CallHistoryScan): readonly Row[];

  protected abstract records(row: Row): RecordDraft<P>[];
}
