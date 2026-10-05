import type { RecordDraft } from '@workspace/elt';
import type { ProtobufMessage } from '@workspace/source-apple-macos/protobuf';

import {
  activityFields,
  appleTime,
  flag,
  integer,
  nonEmpty,
} from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

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

export class WebUsageStream extends BiomeStream<typeof properties> {
  readonly name = 'webUsage';
  readonly biomeName = 'App.WebUsage';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per change of a web page’s usage that Screen Time counts on this Mac (Biome App.WebUsage). Clearing browsing history deletes these records.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      usageId: payload.string(1),
      occurredAt: appleTime(payload.double(2)),
      usageState: integer(payload.uint(3)),
      url: payload.string(4),
      domain: payload.string(5),
      bundleId: payload.string(6),
      usageTrusted: flag(payload.uint(8)),
      safariProfileId: nonEmpty(payload.string(9)),
    };
  }
}
