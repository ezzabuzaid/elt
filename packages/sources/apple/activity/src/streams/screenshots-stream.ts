import type { RecordDraft } from '@workspace/elt';
import type { ProtobufMessage } from '@workspace/source-apple-macos/protobuf';

import { activityFields, integer } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const { integer: integerField } = activityFields;

const properties = {
  ...biomeAddress,
  path: {
    ...activityFields.nullableText,
    description:
      'Where the screenshot was saved; NULL when it went somewhere other than a file.',
  },
  screenshotSource: {
    ...integerField,
    description: 'How the screenshot was taken, as stored.',
  },
  screenshotLocation: {
    ...integerField,
    description: 'Where it was sent, as stored.',
  },
  screenshotStyle: {
    ...integerField,
    description: 'Screenshot style as stored.',
  },
} as const;

export class ScreenshotsStream extends BiomeStream<typeof properties> {
  readonly name = 'screenshots';
  readonly biomeName = 'Screenshots.Screenshot';
  readonly retentionDays = 1;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per screenshot taken on this Mac (Biome Screenshots.Screenshot). macOS keeps these for one day.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    const screenshot = payload.message(1);
    return {
      ...address,
      path: screenshot?.message(4)?.string(1) ?? null,
      screenshotSource: integer(screenshot?.uint(1)),
      screenshotLocation: integer(screenshot?.uint(2)),
      screenshotStyle: integer(screenshot?.uint(6)),
    };
  }
}
