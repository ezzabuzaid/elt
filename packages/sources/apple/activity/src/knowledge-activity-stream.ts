import {
  type CopyConfiguration,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  type SourceMessage,
  Stream,
  type SyncMode,
  diffSnapshot,
  expiredAfter,
  validateRecords,
} from '@workspace/elt';
import type {
  KnowledgeEvent,
  KnowledgeStream,
} from '@workspace/sdk-apple-knowledge';

import type { ActivityScan } from './activity-scan.ts';
import { activityFields, isoTime, retainedSince } from './activity-values.ts';

export const knowledgeEvent = {
  id: {
    ...activityFields.text,
    minLength: 1,
    description: 'knowledgeC event identifier (ZOBJECT.ZUUID).',
  },
  startedAt: {
    ...activityFields.timestamp,
    description:
      'When the event started. macOS drops events once they pass the stream’s maximum age; the row stays loaded.',
  },
  endedAt: {
    ...activityFields.timestamp,
    description: 'When the event ended.',
  },
  createdAt: {
    ...activityFields.timestamp,
    description: 'When knowledgeC stored the event.',
  },
  utcOffsetSeconds: {
    ...activityFields.integer,
    description: 'The device’s offset from UTC when the event happened.',
  },
} as const;

// The fields every knowledgeC row carries, as knowledgeEvent names them.
export const knowledgeEventRecord = (event: KnowledgeEvent) => ({
  id: event.id,
  startedAt: isoTime(event.startedAt),
  endedAt: isoTime(event.endedAt),
  createdAt: isoTime(event.createdAt),
  utcOffsetSeconds: event.utcOffsetSeconds,
});

// An Activity stream over one knowledgeC stream: its description, and how one
// event becomes a row.
export abstract class KnowledgeActivityStream<P extends Properties, E> {
  readonly store = 'knowledge';
  abstract readonly name: string;
  abstract readonly knowledge: KnowledgeStream<E>;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  readonly primaryKey: readonly string[] = Object.freeze(['id']);
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  readonly expiresBy = 'startedAt';
  #stream?: Stream;

  get retentionDays(): number {
    return this.knowledge.maximumAgeDays;
  }

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  async *messages(
    configuration: CopyConfiguration,
    state: unknown,
    scan: ActivityScan,
  ): AsyncGenerator<SourceMessage> {
    const records = this.#read(scan);
    if (configuration.syncMode === 'full_refresh')
      yield* records.map((data) => ({ stream: this.name, data }));
    else
      yield* diffSnapshot(configuration.stream, records, state, {
        covers: expiredAfter(retainedSince(scan.startedAt, this.retentionDays)),
      });
  }

  #read(scan: ActivityScan): SchemaRecord<P>[] {
    return validateRecords(
      this,
      scan.knowledge.events(this.knowledge).map((event) => this.record(event)),
      'Activity',
    );
  }

  protected abstract record(event: KnowledgeEvent & E): RecordDraft<P>;
}
