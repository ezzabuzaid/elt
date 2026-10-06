import {
  type ChatDatabase,
  type ChatMessageRow,
  chatMessageTable,
} from '@workspace/sdk-apple-messages';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  chatGuid,
  columnField,
  countAtMessageGrain,
  encode,
  localStore,
  messageGuid,
  provenance,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  chatGuid,
  messageGuid,
  messageDate: columnField(chatMessageTable, 'message_date'),
  indexState: columnField(chatMessageTable, 'index_state'),
  filterAction: columnField(
    chatMessageTable,
    'filter_action',
    `${provenance(chatMessageTable, 'filter_action')} A copy of the message's message.filter_action (messages.filterAction), which Messages keeps in step.`,
  ),
  filterSubAction: columnField(
    chatMessageTable,
    'filter_sub_action',
    `${provenance(chatMessageTable, 'filter_sub_action')} A copy of the message's message.filter_sub_action (messages.filterSubAction), which Messages keeps in step.`,
  ),
};

export class ChatMessagesStream extends AppleMessagesStream<ChatMessageRow> {
  readonly name = 'chatMessages';
  readonly primaryKey = ['chatGuid', 'messageGuid'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per chat and message link in chat.db chat_message_join, keyed by (chatGuid, messageGuid). chatGuid refers to chats.guid and messageGuid to messages.guid. ${countAtMessageGrain} A message recoverable after deletion is linked through recoverableMessages instead (observed on a live store; Apple does not document this table). ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatMessageRow[] {
    return database.chatMessages();
  }

  protected accepts(row: ChatMessageRow, selection: MessageSelection): boolean {
    return selection.chat(row.chatGuid) && selection.message(row.messageGuid);
  }

  protected records(row: ChatMessageRow): Record<string, unknown>[] {
    return [
      {
        chatGuid: row.chatGuid,
        messageGuid: row.messageGuid,
        messageDate: encode(row.values.message_date ?? null),
        indexState: encode(row.values.index_state ?? null),
        filterAction: encode(row.values.filter_action ?? null),
        filterSubAction: encode(row.values.filter_sub_action ?? null),
      },
    ];
  }
}
