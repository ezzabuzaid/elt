import type { RecordDraft } from '@workspace/elt';
import { AppMenuItem, type AppMenuItemEvent } from '@workspace/sdk-apple-biome';

import { activityFields } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

const properties = {
  ...biomeAddress,
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app whose menu was used.',
  },
} as const;

export class AppMenuItemsStream extends BiomeActivityStream<
  typeof properties,
  AppMenuItemEvent
> {
  readonly name = 'appMenuItems';
  readonly biome = new AppMenuItem();
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per use of an app's menu bar on this Mac (Biome App.MenuItem). Biome records which app, not which item.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: AppMenuItemEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      bundleId: event.bundleId,
    };
  }
}
