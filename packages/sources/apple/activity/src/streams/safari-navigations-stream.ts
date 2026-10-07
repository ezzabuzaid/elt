import type { RecordDraft } from '@workspace/elt';
import {
  SafariNavigations,
  type SafariNavigationsEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const { text } = activityFields;

const properties = {
  ...biomeAddress,
  host: { ...text, description: 'Host of the page navigated to.' },
  url: { ...text, description: 'URL of the page navigated to.' },
  countryCode: {
    ...text,
    description: 'Two-letter country code Biome stores with the navigation.',
  },
  periodEndsAt: {
    ...activityFields.timestamp,
    description:
      'The navigation time rounded up to the next half hour, as stored; recordedAt is the exact time.',
  },
} as const;

export class SafariNavigationsStream extends BiomeActivityStream<
  typeof properties,
  SafariNavigationsEvent
> {
  readonly name = 'safariNavigations';
  readonly biome = new SafariNavigations();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per page navigation Safari reports to Biome on this Mac (Biome Safari.Navigations). Clearing Safari history deletes these records. Its other fields are unnamed and stay in payload.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: SafariNavigationsEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      host: event.host,
      url: event.url,
      countryCode: event.countryCode,
      periodEndsAt: isoTime(event.periodEndsAt),
    };
  }
}
