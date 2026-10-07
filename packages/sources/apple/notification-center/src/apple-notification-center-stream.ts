import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { NotificationCenterScan } from './notification-center-scan.ts';

export const notificationCenterFields = {
  ...eventKitFields,
  nullableInteger: { type: ['integer', 'null'] },
  nullableTextList: { type: ['array', 'null'], items: { type: 'string' } },
  instant: { type: 'string', format: 'date-time', precision: 6 },
  nullableInstant: {
    type: ['string', 'null'],
    format: 'date-time',
    precision: 6,
  },
} as const;

// What the source needs from any Notification Center stream, whatever its
// record type.
export type NotificationCenterReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: NotificationCenterScan): Record<string, unknown>[];
};

// A Notification Center stream: its description, and how its records come
// out of a run's scan. Reading is the same for every stream — pick the rows,
// project each, validate against the schema — so streams supply only those
// two steps.
export abstract class AppleNotificationCenterStream<P extends Properties, Row> {
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
  // Whether a record gone from the store was deleted, or only forgotten.
  abstract readonly emitsDeletes: true | undefined;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  read(scan: NotificationCenterScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      this.rows(scan).flatMap((row) => this.records(row)),
      'Notification Center',
    );
  }

  protected abstract rows(scan: NotificationCenterScan): readonly Row[];

  protected abstract records(row: Row): RecordDraft<P>[];
}
