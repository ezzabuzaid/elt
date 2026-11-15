import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@eltjs/elt';

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

// Where the Teams client keeps an entry of one of its feeds, such as its call
// log: a message of a reply chain of the feed's conversation, 48:<feed>. Each
// such chain holds one message, whose id is the chain's (574 of 574 entries of
// a live store's feeds on 2026-11-15), so a feed entry is held where the
// feed's span holds its chain.
export const feedPlace = {
  store: {
    type: 'string',
    minLength: 1,
    description:
      'The object store of the Teams client that keeps the entry: replychain-manager/replychains or streams-replychain-manager/saved.',
  },
  recordId: {
    type: 'string',
    minLength: 1,
    description:
      'The feed’s reply chain that keeps it, by the ID of the chain’s first message.',
  },
  entry: {
    type: 'string',
    minLength: 1,
    description: 'The entry’s key in that reply chain.',
  },
} as const;

export type TeamsReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: TeamsScan): Record<string, unknown>[];
  covers(scan: TeamsScan, record: VanishedRecord): boolean;
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
  // A new Stream each call: the source asks once, for its catalog.
  describe(): Stream {
    return new Stream(this);
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
  covers(scan: TeamsScan, { key }: VanishedRecord): boolean {
    return scan.keeps(key.accountId);
  }

  protected abstract rows(scan: TeamsScan): readonly Row[];

  protected abstract records(row: Row): RecordDraft<P>[];
}
