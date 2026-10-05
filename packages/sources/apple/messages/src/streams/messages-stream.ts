import {
  type ChatDatabase,
  type Message,
  messageTable,
} from '@workspace/sdk-apple-messages';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  encode,
  localStore,
  provenance,
  tableFields,
  tableRecord,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const { id, nullableText } = eventKitFields;

const properties = {
  guid: {
    ...id,
    description:
      "chat.db message.guid; this stream's primary key. messageGuid in chatMessages, messageAttachments, messageEdits, linkPreviews, recoverableMessages and recoverableMessageParts refers to it within this source.",
  },
  handle: {
    ...nullableText,
    description:
      'chat.db handle.id of the handle message.handle_id points to; together with handleService refers to handles (id, service) within this source. NULL when message.handle_id matches no handle. Which participant it names is not documented by Apple.',
  },
  handleService: {
    ...nullableText,
    description:
      'chat.db handle.service of the handle message.handle_id points to; together with handle refers to handles (id, service) within this source. NULL when message.handle_id matches no handle.',
  },
  otherHandle: {
    ...nullableText,
    description:
      'chat.db handle.id of the handle message.other_handle points to; together with otherHandleService refers to handles (id, service) within this source. NULL when message.other_handle matches no handle. Which participant it names is not documented by Apple.',
  },
  otherHandleService: {
    ...nullableText,
    description:
      'chat.db handle.service of the handle message.other_handle points to; together with otherHandle refers to handles (id, service) within this source. NULL when message.other_handle matches no handle.',
  },
  ...tableFields(messageTable, {
    text: 'Message body: chat.db message.text, or, when that is NULL, the plain text of the NSAttributedString archived in message.attributedBody, which is its first NSString. NULL when neither holds text. attributedBody keeps the archive itself.',
    date: `${provenance(messageTable, 'date')} An import date scope selects messages by this time; which moment Messages records is not documented by Apple.`,
    attributedBody: `${provenance(messageTable, 'attributedBody')} Messages archives the message body here as an NSAttributedString in NeXT typedstream form, which is not a property list and so loads as Base64; text is decoded from it when message.text is NULL. Its other attributes are not decoded.`,
    payload_data: `${provenance(messageTable, 'payload_data')} A richLinkMetadata object in it is decoded into the linkPreviews stream; the meaning of its other contents is not documented by Apple.`,
    message_summary_info: `${provenance(messageTable, 'message_summary_info')} Its "ec" entry is decoded into the messageEdits stream; the meaning of its other keys is not documented by Apple.`,
  }),
};

export class MessagesStream extends AppleMessagesStream<Message> {
  readonly name = 'messages';
  readonly primaryKey = ['guid'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per message in chat.db's message table, keyed by guid. A message recoverable after deletion keeps its record, and its chat link is in recoverableMessages instead of chatMessages (observed on a live store; Apple does not document this table). handle and handleService join handles.id and handles.service, likewise otherHandle and otherHandleService. Chats link through chatMessages and attachments through messageAttachments; both are many-to-many, so joining through them repeats a message: count messages in this stream, or as distinct guid after such a join. Edit versions decoded from messageSummaryInfo are in messageEdits and rich links decoded from payloadData in linkPreviews. chat.db's iCloud deletion bookkeeping (deleted_messages, sync_deleted_*) is not exported. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly Message[] {
    return database.messages();
  }

  protected accepts(message: Message, selection: MessageSelection): boolean {
    return selection.message(message.guid);
  }

  protected records(message: Message): Record<string, unknown>[] {
    return [
      {
        guid: message.guid,
        handle: message.handle?.id ?? null,
        handleService: message.handle?.service ?? null,
        otherHandle: message.otherHandle?.id ?? null,
        otherHandleService: message.otherHandle?.service ?? null,
        ...tableRecord(messageTable, message.values),
        text: encode(message.text),
      },
    ];
  }
}
