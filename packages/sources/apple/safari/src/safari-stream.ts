import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';

import type { SafariScan, SafariStore } from './safari-scan.ts';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;
const integer = { type: 'integer' } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;

export const safariFields = {
  id: { ...text, minLength: 1 },
  nullableId: { ...nullableText, minLength: 1 },
  text,
  nullableText,
  integer,
  nullableInteger,
  ordinal: { ...integer, minimum: 0 },
  nullableNumber: { type: ['number', 'null'] },
  boolean: { type: 'boolean' },
  timestamp: { ...text, format: 'date-time' },
  nullableTimestamp: { ...nullableText, format: 'date-time' },
  profileId: {
    ...text,
    minLength: 1,
    description:
      'Safari profile identifier; refers to profiles.id within this source. The default profile is DefaultProfile.',
  },
} as const;

// What the source needs from any Safari stream, whatever its record type.
export type SafariReader = {
  readonly store: SafariStore;
  describe(): Stream;
  read(scan: SafariScan): Promise<Record<string, unknown>[]>;
  file(record: Record<string, unknown>, scan: SafariScan): string | null;
};

// A Safari stream: its description, the store it reads, and how its records
// come out of a run's scan. Reading is the same for every stream — pick the
// rows, project each, validate against the schema — so streams supply only
// those two steps.
export abstract class SafariStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly store: SafariStore;
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

  async read(scan: SafariScan): Promise<SchemaRecord<P>[]> {
    return validateRecords(
      this,
      this.rows(scan).map((row) => this.record(row, scan)),
      'Safari',
    );
  }

  // The file a record carries, for streams that support file reads.
  file(_record: SchemaRecord<P>, _scan: SafariScan): string | null {
    return null;
  }

  protected abstract rows(scan: SafariScan): readonly Row[];

  protected abstract record(row: Row, scan: SafariScan): RecordDraft<P>;
}
