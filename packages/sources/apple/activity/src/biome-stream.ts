import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ProtobufMessage } from '@workspace/codec-protobuf';
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
import { readSegb, segbFingerprint } from '@workspace/macos-segb';

import type { ActivityScan } from './activity-scan.ts';
import { ActivityUnavailableError } from './activity-store.ts';
import { retainedSince } from './activity-values.ts';

// Bumped whenever a stream's parsing changes, so every segment is read again.
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

// One segment file of a Biome stream, from this Mac or a synced device.
type Segment = {
  readonly origin: string;
  readonly name: string;
  readonly path: string;
};

// Every segment of a Biome stream: local/ holds this Mac's, remote/<device>/
// each synced device's; tombstone/ folders beside them hold Biome's deletion
// log, not records. A stream Biome has not started yet has none.
export async function segments(
  root: string,
  biomeName: string,
): Promise<Segment[]> {
  const files = async (origin: string, directory: string) =>
    (await entries(directory))
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => ({
        origin,
        name: entry.name,
        path: join(directory, entry.name),
      }));
  const stream = join(root, biomeName);
  const devices = (await entries(join(stream, 'remote'))).filter((entry) =>
    entry.isDirectory(),
  );
  return [
    ...(await files('local', join(stream, 'local'))),
    ...(
      await Promise.all(
        devices.map((device) =>
          files(device.name, join(stream, 'remote', device.name)),
        ),
      )
    ).flat(),
  ];
}

async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
      return [];
    throw new ActivityUnavailableError(directory, cause);
  }
}

export const segmentFingerprint = async (segment: Segment) =>
  `${parserVersion}:${await segbFingerprint(segment.path)}`;

// A Biome stream: its description, the Biome stream it reads, how long macOS
// keeps it, and how one record's protobuf becomes a row. Reading is the same
// for every stream — list the segments, read each changed one, project its
// intact records — so streams supply only the projection.
export abstract class BiomeStream<P extends Properties> {
  readonly store = 'biome';
  abstract readonly name: string;
  // Biome's name for the stream, its folder under streams/restricted.
  abstract readonly biomeName: string;
  // The stream's maximum age, compiled into macOS's BiomeLibrary.
  abstract readonly retentionDays: number;
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

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  // Incremental copies read only the segments whose trailer changed, and keep
  // the rows of records macOS expired.
  async *messages(
    configuration: CopyConfiguration,
    state: unknown,
    scan: ActivityScan,
  ): AsyncGenerator<SourceMessage> {
    const found = await segments(scan.biome, this.biomeName);
    if (configuration.syncMode === 'full_refresh') {
      for (const segment of found)
        for await (const data of this.#read(segment))
          yield { stream: this.name, data };
      return;
    }
    const groups = await Promise.all(
      found.map(async (segment) => ({
        key: `${segment.origin}/${segment.name}`,
        fingerprint: await segmentFingerprint(segment),
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

  async *#read(segment: Segment): AsyncGenerator<SchemaRecord<P>> {
    const drafts = (await readSegb(segment.path)).flatMap((record) =>
      record.payload === null
        ? []
        : [
            this.record(new ProtobufMessage(record.payload), {
              origin: segment.origin,
              segment: segment.name,
              slot: record.slot,
              recordedAt: record.writtenAt.toISOString(),
              payload: Buffer.from(record.payload).toString('base64'),
            }),
          ],
    );
    yield* validateRecords(this, drafts, 'Activity');
  }

  protected abstract record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<P>;
}
