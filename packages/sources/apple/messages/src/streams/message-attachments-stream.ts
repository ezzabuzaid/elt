import type {
  ChatDatabase,
  MessageAttachmentRow,
} from '@workspace/sdk-apple-messages';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  countAtMessageGrain,
  localStore,
  messageGuid,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  messageGuid,
  attachmentGuid: {
    ...eventKitFields.id,
    description:
      'chat.db attachment.guid of the linked attachment; refers to attachments.guid within this source.',
  },
};

export class MessageAttachmentsStream extends AppleMessagesStream<MessageAttachmentRow> {
  readonly name = 'messageAttachments';
  readonly primaryKey = ['messageGuid', 'attachmentGuid'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per message and attachment link in chat.db message_attachment_join, keyed by (messageGuid, attachmentGuid). messageGuid refers to messages.guid and attachmentGuid to attachments.guid. ${countAtMessageGrain} ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly MessageAttachmentRow[] {
    return database.messageAttachments();
  }

  protected accepts(
    row: MessageAttachmentRow,
    selection: MessageSelection,
  ): boolean {
    return selection.message(row.messageGuid);
  }

  protected records(row: MessageAttachmentRow): Record<string, unknown>[] {
    return [
      { messageGuid: row.messageGuid, attachmentGuid: row.attachmentGuid },
    ];
  }
}
