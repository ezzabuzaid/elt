import type { ProtobufMessage } from '@workspace/codec-protobuf';
import type { RecordDraft } from '@workspace/elt';

import { activityFields, flag, unixTime } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const properties = {
  ...biomeAddress,
  usageId: {
    ...activityFields.text,
    description:
      'Identifier of one playback; the records that start and stop it share it.',
  },
  started: {
    ...activityFields.boolean,
    description: 'Whether media started (true) or stopped (false).',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When media started or stopped, as the event states it.',
  },
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app playing media.',
  },
  usageTrusted: {
    ...activityFields.boolean,
    description: 'Whether Screen Time counts this usage as trusted.',
  },
} as const;

export class MediaUsageStream extends BiomeStream<typeof properties> {
  readonly name = 'mediaUsage';
  readonly biomeName = 'App.MediaUsage';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per start or stop of media an app played on this Mac, as Screen Time counts it (Biome App.MediaUsage).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      usageId: payload.string(8),
      started: flag(payload.uint(1)),
      occurredAt: unixTime(payload.double(6)),
      bundleId: payload.string(2),
      usageTrusted: flag(payload.uint(5)),
    };
  }
}
