import type { ProtobufMessage } from '@workspace/codec-protobuf';
import type { RecordDraft } from '@workspace/elt';

import { activityFields } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const properties = {
  ...biomeAddress,
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app whose menu was used.',
  },
} as const;

export class AppMenuItemsStream extends BiomeStream<typeof properties> {
  readonly name = 'appMenuItems';
  readonly biomeName = 'App.MenuItem';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      "One source record per use of an app's menu bar on this Mac (Biome App.MenuItem). Biome records which app, not which item.",
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return { ...address, bundleId: payload.string(1) };
  }
}
