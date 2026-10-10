import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import type { Pass } from '@workspace/sdk-apple-wallet';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { WalletScan } from './wallet-scan.ts';

export const walletFields = {
  ...eventKitFields,
  nullableInteger: { type: ['integer', 'null'] },
  nullableNumber: { type: ['number', 'null'] },
  nullableTextList: { type: ['array', 'null'], items: { type: 'string' } },
  // passd's own dates, doubles that resolve below a microsecond.
  walletInstant: {
    type: ['string', 'null'],
    format: 'date-time',
    precision: 6,
  },
  // pass.json's W3C dates, which PassKit reads to the millisecond.
  passInstant: { type: ['string', 'null'], format: 'date-time' },
  offset: { type: ['integer', 'null'], minimum: -1440, maximum: 1440 },
} as const;

// What the source needs from any Wallet stream, whatever its record type.
export type WalletReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: WalletScan): Record<string, unknown>[];
  file(record: Record<string, unknown>): string | null;
};

// A Wallet stream: its description, and the records each pass yields. Reading
// is the same for every stream — project every pass the run read, validate
// against the schema — so streams supply only the projection.
export abstract class AppleWalletStream<P extends Properties> {
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
  // Every read is every pass Wallet holds, so incremental copies diff
  // snapshots, and a pass the user removed is deleted.
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  read(scan: WalletScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      scan.passes.flatMap((pass) => this.records(pass)),
      'Wallet',
    );
  }

  // The file a record carries, for streams that support file reads.
  file(_record: Record<string, unknown>): string | null {
    return null;
  }

  protected abstract records(pass: Pass): RecordDraft<P>[];
}
