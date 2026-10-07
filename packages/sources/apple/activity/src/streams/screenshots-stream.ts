import type { RecordDraft } from '@workspace/elt';
import {
  ScreenshotsScreenshot,
  type ScreenshotsScreenshotEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class ScreenshotsStream extends BiomeActivityStream<
  typeof properties,
  ScreenshotsScreenshotEvent
> {
  readonly name = 'screenshots';
  readonly biome = new ScreenshotsScreenshot();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per screenshot taken on this Mac (Biome Screenshots.Screenshot). macOS keeps these for one day.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: ScreenshotsScreenshotEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      path: event.path ?? null,
      screenshotSource: event.screenshotSource ?? null,
      screenshotLocation: event.screenshotLocation ?? null,
      screenshotStyle: event.screenshotStyle ?? null,
    };
  }
}
