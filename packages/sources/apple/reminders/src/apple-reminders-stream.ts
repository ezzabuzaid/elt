import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { RemindersScan } from './reminders-scan.ts';

export const remindersFields = {
  ...eventKitFields,
  reminderId: {
    ...eventKitFields.id,
    description: 'Owning reminder; refers to reminders.id within this source.',
  },
} as const;

// What the source needs from any Reminders stream, whatever its record type.
export type RemindersReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: RemindersScan): Record<string, unknown>[];
};

// A Reminders stream: its description, and how its records come out of a
// run's scan. Reading is the same for every stream — pick the rows, project
// each, validate against the schema — so streams supply only those two steps.
// Public discovery returns only the Stream description.
export abstract class AppleRemindersStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  readonly primaryKey: readonly string[] = ['id'];
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

  read(scan: RemindersScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      this.rows(scan).map((row) => this.record(row)),
      'EventKit',
    );
  }

  protected abstract rows(scan: RemindersScan): readonly Row[];

  protected abstract record(row: Row): RecordDraft<P>;
}
