import type { RecordDraft } from '@workspace/elt';
import { AppWebUsage, type AppWebUsageEvent } from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const { text } = activityFields;

const properties = {
  ...biomeAddress,
  usageId: {
    ...text,
    description:
      'Identifier of one visit; the records that start and end it share it.',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When the usage state changed, as the event states it.',
  },
  usageState: {
    ...activityFields.integer,
    description:
      'Biome web usage state as stored (1, 2 and 3 observed; a visit starts and ends with different states).',
  },
  url: { ...text, description: 'The page URL.' },
  domain: { ...text, description: 'The web domain Screen Time counts.' },
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the browser.',
  },
  usageTrusted: {
    ...activityFields.boolean,
    description: 'Whether Screen Time counts this usage as trusted.',
  },
  safariProfileId: {
    ...activityFields.nullableText,
    description: 'The Safari profile the page was open in; NULL when none.',
  },
} as const;

export class WebUsageStream extends BiomeActivityStream<
  typeof properties,
  AppWebUsageEvent
> {
  readonly name = 'webUsage';
  readonly biome = new AppWebUsage();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per change of a web page’s usage that Screen Time counts on this Mac (Biome App.WebUsage). Clearing browsing history deletes these records.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: AppWebUsageEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      usageId: event.usageId,
      occurredAt: isoTime(event.occurredAt),
      usageState: event.usageState ?? null,
      url: event.url,
      domain: event.domain,
      bundleId: event.bundleId,
      usageTrusted: event.usageTrusted ?? null,
      safariProfileId: event.safariProfileId ?? null,
    };
  }
}
