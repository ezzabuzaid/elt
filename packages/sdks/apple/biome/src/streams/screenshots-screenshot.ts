import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';

export type ScreenshotsScreenshotEvent = {
  readonly path: string | undefined;
  readonly screenshotSource: number | undefined;
  readonly screenshotLocation: number | undefined;
  readonly screenshotStyle: number | undefined;
};

// A screenshot taken.
export class ScreenshotsScreenshot extends BiomeStream<ScreenshotsScreenshotEvent> {
  readonly name = 'Screenshots.Screenshot';
  readonly maximumAgeDays = 1;

  decode(message: ProtobufMessage): ScreenshotsScreenshotEvent {
    const screenshot = message.message(1);
    return {
      path: screenshot?.message(4)?.string(1),
      screenshotSource: screenshot?.uint(1),
      screenshotLocation: screenshot?.uint(2),
      screenshotStyle: screenshot?.uint(6),
    };
  }
}
