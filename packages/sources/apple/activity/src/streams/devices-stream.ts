import {
  type CopyConfiguration,
  type RecordDraft,
  type SchemaRecord,
  type SourceMessage,
  Stream,
  type SyncMode,
  diffSnapshot,
  validateRecords,
} from '@workspace/elt';
import type { BiomeDevice } from '@workspace/sdk-apple-biome';

import type { ActivityScan } from '../activity-scan.ts';
import { activityFields, isoTime } from '../activity-values.ts';

const { nullableText, nullableInteger } = activityFields;

const properties = {
  deviceId: {
    ...activityFields.text,
    minLength: 1,
    description:
      'Biome identifier of the device; origin in the Biome streams refers to it.',
  },
  thisMac: {
    ...activityFields.boolean,
    description: "Whether it is this Mac, whose records carry origin 'local'.",
  },
  name: {
    ...nullableText,
    description: 'Name of the device; Biome usually leaves it empty (NULL).',
  },
  model: {
    ...nullableText,
    description:
      'What Biome stores as the model, an OS build such as 23G90. The column is numeric, so a build that reads as a number arrives mangled.',
  },
  platform: {
    ...nullableInteger,
    description:
      'Biome device platform as stored: 2 iPhone, 3 Mac desktop, 4 Mac portable, 5 TV observed.',
  },
  lastSyncedAt: {
    ...activityFields.nullableTimestamp,
    description: 'When Biome last synced with the device; NULL for this Mac.',
  },
} as const;

// The devices Biome syncs activity with (sync.db DevicePeer). It changes in
// place and keeps no history, so it diffs like any snapshot and never expires.
export class DevicesStream {
  readonly store = 'devices';
  readonly name = 'devices';
  readonly retentionDays = null;
  readonly primaryKey: readonly string[] = Object.freeze(['deviceId']);
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per device Biome syncs activity with, this Mac included (Biome sync.db DevicePeer).',
    properties,
    required: Object.keys(properties),
  } as const;
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
    else yield* diffSnapshot(configuration.stream, records, state);
  }

  #read(scan: ActivityScan): SchemaRecord<typeof properties>[] {
    return validateRecords(
      this,
      scan.devices.devices().map((device) => this.#record(device)),
      'Activity',
    );
  }

  #record(device: BiomeDevice): RecordDraft<typeof properties> {
    return {
      deviceId: device.id,
      thisMac: device.thisMac,
      name: device.name ?? null,
      model: device.model ?? null,
      platform: device.platform ?? null,
      lastSyncedAt: isoTime(device.lastSyncedAt),
    };
  }
}
