import {
  type CopyConfiguration,
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  type SourceMessage,
  Stream,
  type SyncMode,
  diffGroupedSnapshot,
  validateRecords,
} from '@workspace/elt';
import type { BiomeSegment, BiomeStream } from '@workspace/sdk-apple-biome';

import type { ActivityScan } from './activity-scan.ts';
import { retainedSince } from './activity-values.ts';

// Bumped whenever a stream's records change shape, so every segment is read
// again.
const parserVersion = 1;

// Where a Biome record lives. Biome never compacts a segment, so the address
// identifies the record until it is deleted.
export type BiomeAddress = {
  readonly origin: string;
  readonly segment: string;
  readonly slot: number;
  readonly recordedAt: string;
  readonly payload: string;
};

export const biomeAddress = {
  origin: {
    type: 'string',
    minLength: 1,
    description:
      "Where the record was written: 'local' for this Mac, otherwise the identifier of the synced device it came from (devices.deviceId when Biome lists the device).",
  },
  segment: {
    type: 'string',
    minLength: 1,
    description:
      'The Biome segment file holding the record, named for when the writing device started it, in microseconds since 2001-01-01.',
  },
  slot: {
    type: 'integer',
    minimum: 0,
    description:
      "The record's place in its segment, 0 for the first. With origin and segment it identifies the record.",
  },
  recordedAt: {
    type: 'string',
    format: 'date-time',
    description:
      'When Biome wrote the record. macOS drops records once they pass the stream’s maximum age; the row stays loaded.',
  },
  payload: {
    type: 'string',
    description:
      "The record's protobuf exactly as Biome stores it, base64. Biome's format is private: fields this stream does not name stay readable here.",
  },
} as const;

// An Activity stream over one Biome stream: its description, and how one
// decoded event becomes a row. Reading is the same for every stream — list
// the segments, read each changed one, project its records — so streams
// supply only the projection.
export abstract class BiomeActivityStream<P extends Properties, E> {
  readonly store = 'biome';
  abstract readonly name: string;
  abstract readonly biome: BiomeStream<E>;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  readonly primaryKey: readonly string[] = Object.freeze([
    'origin',
    'segment',
    'slot',
  ]);
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  readonly expiresBy = 'recordedAt';
  #stream?: Stream;

  get retentionDays(): number {
    return this.biome.maximumAgeDays;
  }

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  // Incremental copies read only the segments whose fingerprint changed, and
  // keep the rows of records macOS expired.
  async *messages(
    configuration: CopyConfiguration,
    state: unknown,
    scan: ActivityScan,
  ): AsyncGenerator<SourceMessage> {
    const found = await scan.biome.segments(this.biome);
    if (configuration.syncMode === 'full_refresh') {
      for (const segment of found)
        for await (const data of this.#read(segment))
          yield { stream: this.name, data };
      return;
    }
    const groups = await Promise.all(
      found.map(async (segment) => ({
        key: `${segment.origin}/${segment.name}`,
        fingerprint: `${parserVersion}:${await segment.fingerprint()}`,
        records: () => this.#read(segment),
      })),
    );
    yield* diffGroupedSnapshot(
      configuration.stream,
      groups,
      state,
      retainedSince(scan.startedAt, this.retentionDays),
    );
  }

  async *#read(segment: BiomeSegment<E>): AsyncGenerator<SchemaRecord<P>> {
    const drafts = (await segment.records()).map((record) =>
      this.record(record.event, {
        origin: segment.origin,
        segment: segment.name,
        slot: record.slot,
        recordedAt: record.writtenAt.toISOString(),
        payload: Buffer.from(record.payload).toString('base64'),
      }),
    );
    yield* validateRecords(this, drafts, 'Activity');
  }

  protected abstract record(event: E, address: BiomeAddress): RecordDraft<P>;
}
