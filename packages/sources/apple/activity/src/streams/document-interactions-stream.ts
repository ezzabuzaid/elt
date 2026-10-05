import type { ProtobufMessage } from '@workspace/codec-protobuf';
import type { RecordDraft } from '@workspace/elt';

import { activityFields, integer } from '../activity-values.ts';
import {
  type BiomeAddress,
  BiomeStream,
  biomeAddress,
} from '../biome-stream.ts';

const { text } = activityFields;

const properties = {
  ...biomeAddress,
  interactionType: {
    ...activityFields.integer,
    description: 'Biome document interaction type as stored (1 observed).',
  },
  path: { ...text, description: 'Path of the document.' },
  contentType: {
    ...text,
    description:
      'Uniform type identifier of the document, such as com.adobe.pdf.',
  },
  bundleId: {
    ...activityFields.bundleId,
    description: 'Bundle identifier of the app the document was used in.',
  },
  appUrl: { ...text, description: 'File URL of that app.' },
} as const;

export class DocumentInteractionsStream extends BiomeStream<typeof properties> {
  readonly name = 'documentInteractions';
  readonly biomeName = 'App.DocumentInteraction';
  readonly retentionDays = 28;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per document an app opened or used on this Mac (Biome App.DocumentInteraction). The file’s bookmark data stays in payload.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    payload: ProtobufMessage,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    const file = payload.message(2);
    const app = payload.message(4);
    return {
      ...address,
      interactionType: integer(payload.uint(1)),
      path: file?.string(1),
      contentType: payload.string(3),
      bundleId: app?.string(1),
      appUrl: app?.string(2),
    };
  }
}
