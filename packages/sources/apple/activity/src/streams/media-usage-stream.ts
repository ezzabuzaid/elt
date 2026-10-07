import type { RecordDraft } from '@workspace/elt';
import {
  AppMediaUsage,
  type AppMediaUsageEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class MediaUsageStream extends BiomeActivityStream<
  typeof properties,
  AppMediaUsageEvent
> {
  readonly name = 'mediaUsage';
  readonly biome = new AppMediaUsage();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per start or stop of media an app played on this Mac, as Screen Time counts it (Biome App.MediaUsage).',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: AppMediaUsageEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      usageId: event.usageId,
      started: event.started ?? null,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      usageTrusted: event.usageTrusted ?? null,
    };
  }
}
