import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';

export type AppDocumentInteractionEvent = {
  readonly interactionType: number | undefined;
  readonly path: string | undefined;
  readonly contentType: string | undefined;
  readonly bundleId: string | undefined;
  readonly appUrl: string | undefined;
};

// A document an app opened or used.
export class AppDocumentInteraction extends BiomeStream<AppDocumentInteractionEvent> {
  readonly name = 'App.DocumentInteraction';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): AppDocumentInteractionEvent {
    const file = message.message(2);
    const app = message.message(4);
    return {
      interactionType: message.uint(1),
      path: file?.string(1),
      contentType: message.string(3),
      bundleId: app?.string(1),
      appUrl: app?.string(2),
    };
  }
}
