import type { RecordDraft } from '@workspace/elt';
import type { ProtobufMessage } from '@workspace/source-apple-macos/protobuf';

import { activityFields, unixTime } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

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

export class SafariNavigationsStream extends BiomeStream<typeof properties> {
  readonly name = 'safariNavigations';
  readonly biomeName = 'Safari.Navigations';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per page navigation Safari reports to Biome on this Mac (Biome Safari.Navigations). Clearing Safari history deletes these records. Its other fields are unnamed and stay in payload.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      host: payload.string(1),
      url: payload.string(8),
      countryCode: payload.string(5),
      periodEndsAt: unixTime(payload.double(2)),
    };
  }
}
