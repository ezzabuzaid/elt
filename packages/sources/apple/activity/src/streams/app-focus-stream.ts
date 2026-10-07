import type { RecordDraft } from '@workspace/elt';
import { AppInFocus, type AppInFocusEvent } from '@workspace/sdk-apple-biome';

import { activityFields, isoTime } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class AppFocusStream extends BiomeActivityStream<
  typeof properties,
  AppInFocusEvent
> {
  readonly name = 'appFocus';
  readonly biome = new AppInFocus();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per app focus change (Biome App.InFocus) on this Mac and the devices it syncs with: an app coming into the foreground, or leaving it. A session runs from a start to the next end of the same app and origin.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: AppInFocusEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      started: event.started ?? null,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      launchReason: event.launchReason ?? null,
      eventType: event.eventType ?? null,
      shortVersion: event.shortVersion ?? null,
      bundleVersion: event.bundleVersion ?? null,
      platform: event.platform ?? null,
      nativeArchitecture: event.nativeArchitecture ?? null,
      displayType: event.displayType ?? null,
    };
  }
}
