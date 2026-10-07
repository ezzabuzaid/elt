import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';

export type AppMenuItemEvent = {
  readonly bundleId: string | undefined;
};

// A use of an app's menu bar; Biome records which app, not which item.
export class AppMenuItem extends BiomeStream<AppMenuItemEvent> {
  readonly name = 'App.MenuItem';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): AppMenuItemEvent {
    return { bundleId: message.string(1) };
  }
}
