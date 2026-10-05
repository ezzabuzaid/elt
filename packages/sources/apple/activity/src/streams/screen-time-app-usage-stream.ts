import type { RecordDraft } from '@workspace/elt';
import type { ProtobufMessage } from '@workspace/source-apple-macos/protobuf';

import { activityFields, flag, unixTime } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const properties = {
  ...biomeAddress,
  started: {
    ...activityFields.boolean,
    description: 'Whether app usage started (true) or ended (false).',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When usage started or ended, as the event states it.',
  },
  bundleId: activityFields.bundleId,
  usageTrusted: {
    ...activityFields.boolean,
    description: 'Whether Screen Time counts this usage as trusted.',
  },
} as const;

export class ScreenTimeAppUsageStream extends BiomeStream<typeof properties> {
  readonly name = 'screenTimeAppUsage';
  readonly biomeName = 'ScreenTime.AppUsage';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per start or end of app usage that Screen Time counts (Biome ScreenTime.AppUsage) on this Mac. It follows appFocus without system interface such as the Dock or the login window.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      started: flag(payload.uint(1)),
      occurredAt: unixTime(payload.double(2)),
      bundleId: payload.string(3),
      usageTrusted: flag(payload.uint(5)),
    };
  }
}
