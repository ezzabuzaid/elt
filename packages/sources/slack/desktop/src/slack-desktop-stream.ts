import {
  type KeyValue,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';

import type { SlackDesktopScan } from './slack-desktop-scan.ts';

export const slackFields = {
  id: { type: 'string', minLength: 1 },
  ordinal: { type: 'integer', minimum: 0 },
  nullableText: { type: ['string', 'null'] },
  nullableBoolean: { type: ['boolean', 'null'] },
  nullableInteger: { type: ['integer', 'null'] },
  nullableTimestamp: { type: ['string', 'null'], format: 'date-time' },
  textList: { type: 'array', items: { type: 'string' } },
  // Slack's ts, seconds and microseconds, kept as the text Slack writes.
  ts: { type: 'string', minLength: 1 },
  nullableTs: { type: ['string', 'null'] },
  // A ts as an instant, to the microsecond.
  instant: { type: 'string', format: 'date-time', precision: 6 },
} as const;

export type SlackDesktopReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: SlackDesktopScan): Record<string, unknown>[];
  covers(
    scan: SlackDesktopScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean;
};

// A Slack stream: its description, and how its records come out of a run's
// scan. Reading is the same for every stream — pick the rows, project each,
// validate against the schema — so streams supply only those two steps.
export abstract class SlackDesktopStream<P extends Properties, Row> {
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
  // Whether a record the app no longer holds, where the read covers it, was
  // deleted; a stream whose upstream only forgets says undefined.
  readonly emitsDeletes: true | undefined = true;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  read(scan: SlackDesktopScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      this.rows(scan).flatMap((row) => this.records(row)),
      'Slack',
    );
  }

  // Whether the scan vouches for a row it no longer holds, so that it was
  // deleted: every row of a workspace the app still keeps.
  covers(
    scan: SlackDesktopScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.keeps(key.workspaceId);
  }

  protected abstract rows(scan: SlackDesktopScan): readonly Row[];

  protected abstract records(row: Row): RecordDraft<P>[];
}
