import type { ProtobufMessage } from '@workspace/codec-protobuf';
import type { RecordDraft } from '@workspace/elt';

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

const { nullableText, nullableInteger } = activityFields;

// MediaRemote's "unknown duration".
const unknownDuration = 4_294_967_295;

const properties = {
  ...biomeAddress,
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When playback changed, as the event states it.',
  },
  playbackState: {
    ...activityFields.integer,
    description:
      'MediaRemote playback state as stored: 1 playing, 2 paused, 3 stopped (0 also observed).',
  },
  title: { ...nullableText, description: 'Title of what was playing.' },
  artist: { ...nullableText, description: 'Artist of what was playing.' },
  album: { ...nullableText, description: 'Album of what was playing.' },
  durationSeconds: {
    ...nullableInteger,
    description: 'Length of what was playing; NULL when unknown.',
  },
  mediaType: {
    ...nullableText,
    description:
      'MediaRemote media type, such as kMRMediaRemoteNowPlayingInfoTypeVideo; NULL when not given.',
  },
  airPlayVideo: {
    ...activityFields.boolean,
    description: 'Whether the video played over AirPlay.',
  },
  bundleId: {
    ...activityFields.nullableText,
    description:
      'Bundle identifier of the app playing; NULL when Biome recorded none.',
  },
  outputDeviceIds: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Identifiers of the audio routes playback went to, as recorded on an iPhone; empty when none were recorded.',
  },
} as const;

export class NowPlayingStream extends BiomeStream<typeof properties> {
  readonly name = 'nowPlaying';
  readonly biomeName = 'Media.NowPlaying';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Now Playing change on this Mac and the devices it syncs with (Biome Media.NowPlaying): what played, in which app, and whether it played, paused or stopped.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    const duration = integer(payload.uint(6));
    return {
      ...address,
      occurredAt: appleTime(payload.double(2)),
      playbackState: integer(payload.uint(3)),
      title: nonEmpty(payload.string(8)),
      artist: nonEmpty(payload.string(5)),
      album: nonEmpty(payload.string(4)),
      durationSeconds: duration === unknownDuration ? null : duration,
      mediaType: nonEmpty(payload.string(10)),
      airPlayVideo: flag(payload.uint(13)),
      bundleId: nonEmpty(payload.string(15)),
      outputDeviceIds: payload
        .messages(14)
        .flatMap((device) => nonEmpty(device.string(3)) ?? []),
    };
  }
}
