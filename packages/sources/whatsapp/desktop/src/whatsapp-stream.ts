import { ClosedWorld, Retention } from '@zukhruf/snapshot-differential';

import {
  type CopyConfiguration,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';
import type { WhatsAppStore } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from './whatsapp-scan.ts';

const text = { type: 'string' } as const;
const nullableText = { type: ['string', 'null'] } as const;

export const whatsappFields = {
  jid: { ...text, minLength: 1 },
  nullableJid: { ...nullableText, minLength: 1 },
  text,
  nullableText,
  integer: { type: 'integer' },
  nullableInteger: { type: ['integer', 'null'] },
  nullableNumber: { type: ['number', 'null'] },
  boolean: { type: 'boolean' },
  nullableBoolean: { type: ['boolean', 'null'] },
  // Core Data's dates: seconds since 2001 in a double, to the microsecond.
  instant: { ...text, format: 'date-time', precision: 6 },
  nullableInstant: { ...nullableText, format: 'date-time', precision: 6 },
  nullableBase64: { ...nullableText, contentEncoding: 'base64' },
} as const;

// A blob as a record holds it.
export const base64 = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString('base64');

// What the source needs from any WhatsApp stream, whatever its record type.
export type WhatsAppReader = {
  readonly name: string;
  readonly store: WhatsAppStore;
  describe(): Stream;
  changes(
    configuration: CopyConfiguration,
    scan: WhatsAppScan,
    state: unknown,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof diffSnapshot<Record<string, unknown>>>;
  file(record: Record<string, unknown>, scan: WhatsAppScan): string | null;
};

// A WhatsApp stream: its description, the store it reads, and how its
// records come out of a run's scan. Reading is the same for every stream —
// pick the rows, project each, validate against the schema — so streams
// supply only those two steps.
export abstract class WhatsAppStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly store: WhatsAppStore;
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

  // One record at a time, so a pass never holds a whole store's rows.
  *read(scan: WhatsAppScan): Generator<SchemaRecord<P>> {
    yield* this.records(this.rows(scan));
  }

  changes(
    configuration: CopyConfiguration,
    scan: WhatsAppScan,
    state: unknown,
    signal: AbortSignal | undefined,
  ): ReturnType<typeof diffSnapshot<SchemaRecord<P>>> {
    const horizon = this.horizon(scan);
    return diffSnapshot(configuration, this.read(scan), state, {
      policy:
        horizon === undefined ? new ClosedWorld() : new Retention(horizon),
      signal,
    });
  }

  protected *records(rows: Iterable<Row>): Generator<SchemaRecord<P>> {
    for (const row of rows)
      yield* validateRecords(this, [this.record(row)], 'WhatsApp');
  }

  // The instant WhatsApp keeps the stream's records from, for streams it
  // expires (see Stream.expiresBy).
  horizon(_scan: WhatsAppScan): string | undefined {
    return undefined;
  }

  // The file a record carries, for streams that support file reads.
  file(_record: SchemaRecord<P>, _scan: WhatsAppScan): string | null {
    return null;
  }

  protected abstract rows(scan: WhatsAppScan): Iterable<Row>;

  protected abstract record(row: Row): RecordDraft<P>;
}
