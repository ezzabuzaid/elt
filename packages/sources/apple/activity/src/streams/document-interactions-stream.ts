import type { RecordDraft } from '@workspace/elt';
import {
  AppDocumentInteraction,
  type AppDocumentInteractionEvent,
} from '@workspace/sdk-apple-biome';

import { activityFields } from '../activity-values.ts';
import {
  BiomeActivityStream,
  type BiomeAddress,
  biomeAddress,
} from '../biome-activity-stream.ts';

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

export class DocumentInteractionsStream extends BiomeActivityStream<
  typeof properties,
  AppDocumentInteractionEvent
> {
  readonly name = 'documentInteractions';
  readonly biome = new AppDocumentInteraction();
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per document an app opened or used on this Mac (Biome App.DocumentInteraction). The file’s bookmark data stays in payload.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected record(
    event: AppDocumentInteractionEvent,
    address: BiomeAddress,
  ): RecordDraft<typeof properties> {
    return {
      ...address,
      interactionType: event.interactionType ?? null,
      path: event.path,
      contentType: event.contentType,
      bundleId: event.bundleId,
      appUrl: event.appUrl,
    };
  }
}
