import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  validateRecords,
} from '@eltjs/elt';
import type {
  ClockSnapshot,
  ClockStoreKind,
} from '@eltjs/sdk-apple-clock/clock-store';

export const fields = {
  id: { type: 'string', minLength: 1 },
  text: { type: ['string', 'null'] },
  number: { type: ['number', 'null'] },
  integer: { type: ['integer', 'null'] },
  boolean: { type: ['boolean', 'null'] },
  instant: { type: ['string', 'null'], format: 'date-time', precision: 6 },
  bytes: { type: ['string', 'null'], contentEncoding: 'base64' },
  int64: { type: ['string', 'null'], format: 'int64' },
  position: { type: 'integer', minimum: 0 },
} as const;

export abstract class ClockStream<P extends Properties> {
  abstract readonly name: string;
  abstract readonly store: ClockStoreKind;
  abstract readonly description: string;
  abstract readonly properties: P;
  abstract readonly primaryKey: readonly string[];
  // A new Stream each call: the source asks once, for its catalog.
  describe(): Stream {
    return new Stream({
      name: this.name,
      jsonSchema: {
        type: 'object',
        description: this.description,
        properties: this.properties,
        required: Object.keys(this.properties),
      },
      primaryKey: this.primaryKey,
      supportedSyncModes: ['full_refresh', 'incremental'],
      sourceDefinedCursor: true,
      emitsDeletes: true,
    });
  }
  read(snapshot: ClockSnapshot): SchemaRecord<P>[] {
    return validateRecords(
      { name: this.name, jsonSchema: { properties: this.properties } },
      this.rows(snapshot),
      'Clock',
    );
  }
  protected abstract rows(snapshot: ClockSnapshot): RecordDraft<P>[];
}
