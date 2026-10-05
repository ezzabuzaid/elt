import type {
  ChatDatabase,
  MessagePayload,
} from '@workspace/sdk-apple-messages';
import { plistJSON } from '@workspace/sdk-apple-plist';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import { localStore, messageGuid, unverified } from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const { text, nullableText } = eventKitFields;

const properties = {
  messageGuid,
  url: {
    ...nullableText,
    description:
      'richLinkMetadata.URL, which Apple documents as the URL that returned the metadata, taking server-side redirects into account; NULL when absent or not text.',
  },
  originalUrl: {
    ...nullableText,
    description:
      'richLinkMetadata.originalURL, which Apple documents as the original URL of the metadata request; NULL when absent or not text.',
  },
  title: {
    ...nullableText,
    description:
      'richLinkMetadata.title, which Apple documents as a representative title for the URL; NULL when absent or not text.',
  },
  summary: {
    ...nullableText,
    description: `richLinkMetadata.summary; NULL when absent or not text. ${unverified}`,
  },
  siteName: {
    ...nullableText,
    description: `richLinkMetadata.siteName; NULL when absent or not text. ${unverified}`,
  },
  itemType: {
    ...nullableText,
    description: `richLinkMetadata.itemType; NULL when absent or not text. ${unverified}`,
  },
  creator: {
    ...nullableText,
    description: `richLinkMetadata.creator; NULL when absent or not text. ${unverified}`,
  },
  metadata: {
    ...text,
    description:
      'The whole unarchived richLinkMetadata object as JSON, with its "$class", nested data as Base64 and dates as ISO 8601; keeps the fields not extracted above.',
  },
};

// The rich link a URL message shows, decoded from its payload_data archive.
export class LinkPreviewsStream extends AppleMessagesStream<MessagePayload> {
  readonly name = 'linkPreviews';
  readonly primaryKey = ['messageGuid'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per message whose chat.db message.payload_data archive holds a richLinkMetadata object, keyed by messageGuid, which refers to messages.guid. metadata keeps the object's archived class as "$class"; url, originalUrl and title follow Apple's LPLinkMetadata documentation. Other messages have no record; messages.payloadData keeps the archive. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly MessagePayload[] {
    return database.payloads();
  }

  protected accepts(
    payload: MessagePayload,
    selection: MessageSelection,
  ): boolean {
    return selection.message(payload.messageGuid);
  }

  protected records(payload: MessagePayload): Record<string, unknown>[] {
    const preview = payload.linkPreview();
    if (preview === null) return [];
    return [
      {
        messageGuid: payload.messageGuid,
        url: preview.url,
        originalUrl: preview.originalUrl,
        title: preview.title,
        summary: preview.summary,
        siteName: preview.siteName,
        itemType: preview.itemType,
        creator: preview.creator,
        metadata: plistJSON(preview.metadata),
      },
    ];
  }
}
