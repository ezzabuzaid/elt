import type { ProtobufMessage } from '@workspace/codec-protobuf';

import { BiomeStream } from '../biome-stream.ts';
import { appleDate, flag, optionalText } from '../biome-values.ts';

// MediaRemote's "unknown duration".
const unknownDuration = 4_294_967_295;

export type MediaNowPlayingEvent = {
  readonly occurredAt: Date | undefined;
  readonly playbackState: number | undefined;
  readonly title: string | undefined;
  readonly artist: string | undefined;
  readonly album: string | undefined;
  readonly durationSeconds: number | undefined;
  readonly mediaType: string | undefined;
  readonly airPlayVideo: boolean | undefined;
  readonly bundleId: string | undefined;
  // The audio routes playback went to, as an iPhone records them.
  readonly outputDeviceIds: string[];
};

// A Now Playing change.
export class MediaNowPlaying extends BiomeStream<MediaNowPlayingEvent> {
  readonly name = 'Media.NowPlaying';
  readonly maximumAgeDays = 28;

  decode(message: ProtobufMessage): MediaNowPlayingEvent {
    const duration = message.uint(6);
    return {
      occurredAt: appleDate(message.double(2)),
      playbackState: message.uint(3),
      title: optionalText(message.string(8)),
      artist: optionalText(message.string(5)),
      album: optionalText(message.string(4)),
      durationSeconds: duration === unknownDuration ? undefined : duration,
      mediaType: optionalText(message.string(10)),
      airPlayVideo: flag(message.uint(13)),
      bundleId: optionalText(message.string(15)),
      outputDeviceIds: message
        .messages(14)
        .flatMap((device) => optionalText(device.string(3)) ?? []),
    };
  }
}
