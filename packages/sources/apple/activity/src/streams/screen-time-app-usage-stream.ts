import type { RecordDraft } from '@workspace/elt';
import {
  ScreenTimeAppUsage,
  type ScreenTimeAppUsageEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class ScreenTimeAppUsageStream extends BiomeActivityStream<
  typeof properties,
  ScreenTimeAppUsageEvent
> {
  readonly name = 'screenTimeAppUsage';
  readonly biome = new ScreenTimeAppUsage();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per start or end of app usage that Screen Time counts (Biome ScreenTime.AppUsage) on this Mac. It follows appFocus without system interface such as the Dock or the login window.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: ScreenTimeAppUsageEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      started: event.started ?? null,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      usageTrusted: event.usageTrusted ?? null,
    };
  }
}
