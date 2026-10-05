import {
  type ChatDatabase,
  type ChatRow,
  chatTable,
} from '@workspace/sdk-apple-messages';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  localStore,
  provenance,
  tableFields,
  tableRecord,
  unverified,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  guid: {
    ...eventKitFields.id,
    description:
      "chat.db chat.guid; this stream's primary key. chatGuid in chatLookups, chatServices, chatHandles, chatMessages, recoverableMessages and recoverableMessageParts refers to it within this source.",
  },
  ...tableFields(chatTable, {
    account_id: `${provenance(chatTable, 'account_id')} An import scope's account selection matches chats by this value. ${unverified}`,
  }),
};

export class ChatsStream extends AppleMessagesStream<ChatRow> {
  readonly name = 'chats';
  readonly primaryKey = ['guid'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per chat in chat.db's chat table, keyed by guid. Its handles are in chatHandles, its messages in chatMessages, or in recoverableMessages while recoverable after deletion, its lookup identifiers in chatLookups and its services in chatServices, each by chatGuid. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatRow[] {
    return database.chats();
  }

  protected accepts(row: ChatRow, selection: MessageSelection): boolean {
    return selection.chat(row.guid);
  }

  protected records(row: ChatRow): Record<string, unknown>[] {
    return [{ guid: row.guid, ...tableRecord(chatTable, row.values) }];
  }
}
