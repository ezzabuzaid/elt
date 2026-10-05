import {
  type CopyConfiguration,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  type SourceMessage,
  Stream,
  type SyncMode,
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';

import type { ActivityScan } from './activity-scan.ts';
import { type Row, activityFields, retainedSince } from './activity-values.ts';

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

// The ZOBJECT columns every event row carries, read as knowledgeEvent fields.
const eventColumns =
  'o.ZUUID, o.ZSTARTDATE, o.ZENDDATE, o.ZCREATIONDATE, o.ZSECONDSFROMGMT';

// A knowledgeC stream: one ZSTREAMNAME, with its metadata (ZSTRUCTUREDMETADATA)
// and source (ZSOURCE) joined. Streams supply the extra columns they read and
// how a row becomes a record.
export abstract class KnowledgeStream<P extends Properties> {
  readonly store = 'knowledge';
  abstract readonly name: string;
  // knowledgeC's name for the stream, ZOBJECT.ZSTREAMNAME.
  abstract readonly streamName: string;
  // The stream's maximum age, compiled into macOS's BiomeLibrary.
  abstract readonly retentionDays: number;
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
  protected abstract readonly columns: string;
  #stream?: Stream;

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
      yield* diffSnapshot(
        configuration.stream,
        records,
        state,
        retainedSince(scan.startedAt, this.retentionDays),
      );
  }

  #read(scan: ActivityScan): SchemaRecord<P>[] {
    const rows = scan.knowledge.all(
      `SELECT ${eventColumns}, ${this.columns}
       FROM ZOBJECT o
       LEFT JOIN ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA
       LEFT JOIN ZSOURCE s ON s.Z_PK = o.ZSOURCE
       WHERE o.ZSTREAMNAME = ? ORDER BY o.Z_PK`,
      this.streamName,
    );
    return validateRecords(
      this,
      rows.map((row) => this.record(row)),
      'Activity',
    );
  }

  protected abstract record(row: Row): RecordDraft<P>;
}
