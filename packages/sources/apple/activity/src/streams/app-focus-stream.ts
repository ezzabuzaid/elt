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

const { nullableText, nullableInteger, nullableBoolean } = activityFields;

const properties = {
  ...biomeAddress,
  started: {
    ...activityFields.boolean,
    description:
      'Whether the app came into focus (true) or left it (false). One switch writes an end for the app left and a start for the app entered, at the same instant.',
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: 'When the focus changed, as the event states it.',
  },
  bundleId: activityFields.bundleId,
  launchReason: {
    ...nullableText,
    description:
      'Why the app came forward on an iPhone, such as com.apple.SpringBoard.transitionReason.appswitcher; NULL on a Mac.',
  },
  eventType: {
    ...activityFields.integer,
    description: 'Biome focus event type as stored (1 observed on a Mac).',
  },
  shortVersion: {
    ...nullableText,
    description: "The app's version (CFBundleShortVersionString).",
  },
  bundleVersion: {
    ...nullableText,
    description: "The app's build (CFBundleVersion).",
  },
  platform: {
    ...nullableInteger,
    description:
      "The app's dyld platform: 1 macOS, 6 Mac Catalyst; NULL when not recorded, as on an iPhone.",
  },
  nativeArchitecture: {
    ...nullableBoolean,
    description:
      'Whether the app ran natively rather than under Rosetta; NULL when not recorded.',
  },
  displayType: {
    ...nullableInteger,
    description: 'Biome display type as stored.',
  },
} as const;

export class AppFocusStream extends BiomeStream<typeof properties> {
  readonly name = 'appFocus';
  readonly biomeName = 'App.InFocus';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per app focus change (Biome App.InFocus) on this Mac and the devices it syncs with: an app coming into the foreground, or leaving it. A session runs from a start to the next end of the same app and origin.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      started: flag(payload.uint(3)),
      occurredAt: appleTime(payload.double(4)),
      bundleId: payload.string(6),
      launchReason: nonEmpty(payload.string(1)),
      eventType: integer(payload.uint(2)),
      shortVersion: nonEmpty(payload.string(9)),
      bundleVersion: nonEmpty(payload.string(10)),
      platform: integer(payload.uint(11)),
      nativeArchitecture: flag(payload.uint(12)),
      displayType: integer(payload.uint(13)),
    };
  }
}
