import type { KeyValue } from '@zukhruf/snapshot-differential';

import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';

import type { TeamsScan } from './teams-scan.ts';

export const teamsFields = {
  id: { type: 'string', minLength: 1 },
  position: { type: 'integer', minimum: 0 },
  nullableText: { type: ['string', 'null'] },
  nullableBoolean: { type: ['boolean', 'null'] },
  nullableInteger: { type: ['integer', 'null'] },
  textList: { type: 'array', items: { type: 'string' } },
  accountId: {
    type: 'string',
    minLength: 1,
    description: 'The account (accounts.id).',
  },
  conversationId: {
    type: 'string',
    minLength: 1,
    description: 'The conversation (conversations.id).',
  },
  instant: { type: 'string', format: 'date-time' },
  nullableInstant: { type: ['string', 'null'], format: 'date-time' },
  // The calling service's times, to the ten-millionth of a second.
  nullablePreciseInstant: {
    type: ['string', 'null'],
    format: 'date-time',
    precision: 7,
  },
} as const;

export type TeamsReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: TeamsScan): Record<string, unknown>[];
  covers(scan: TeamsScan, key: Readonly<Record<string, KeyValue>>): boolean;
};

// A Teams stream: its description, and how its records come out of a run's
// scan. Reading is the same for every stream — pick the rows, project each,
// validate against the schema — so streams supply only those two steps.
export abstract class TeamsStream<P extends Properties, Row> {
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

  read(scan: TeamsScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      this.rows(scan).flatMap((row) => this.records(row)),
      'Microsoft Teams',
    );
  }

  // Whether the scan vouches for a row it no longer holds, so that it was
  // deleted: every row of an account the app still keeps.
  covers(scan: TeamsScan, key: Readonly<Record<string, KeyValue>>): boolean {
    return scan.keeps(key.accountId);
  }

  protected abstract rows(scan: TeamsScan): readonly Row[];

  protected abstract records(row: Row): RecordDraft<P>[];
}
