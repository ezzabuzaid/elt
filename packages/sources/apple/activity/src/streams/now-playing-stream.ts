import type { RecordDraft } from '@workspace/elt';
import {
  MediaNowPlaying,
  type MediaNowPlayingEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const { nullableText, nullableInteger } = activityFields;

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

export class NowPlayingStream extends BiomeActivityStream<
  typeof properties,
  MediaNowPlayingEvent
> {
  readonly name = 'nowPlaying';
  readonly biome = new MediaNowPlaying();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per Now Playing change on this Mac and the devices it syncs with (Biome Media.NowPlaying): what played, in which app, and whether it played, paused or stopped.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: MediaNowPlayingEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      occurredAt: isoTime(event.occurredAt),
      playbackState: event.playbackState ?? null,
      title: event.title ?? null,
      artist: event.artist ?? null,
      album: event.album ?? null,
      durationSeconds: event.durationSeconds ?? null,
      mediaType: event.mediaType ?? null,
      airPlayVideo: event.airPlayVideo ?? null,
      bundleId: event.bundleId ?? null,
      outputDeviceIds: event.outputDeviceIds,
    };
  }
}
