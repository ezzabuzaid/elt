import {
  type ChatDatabase,
  type ChatMessageRow,
  recoverableMessageTable,
} from '@workspace/sdk-apple-messages';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  chatGuid,
  columnField,
  countAtMessageGrain,
  encode,
  localStore,
  messageGuid,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  chatGuid,
  messageGuid,
  deleteDate: columnField(recoverableMessageTable, 'delete_date'),
  ckSyncState: columnField(recoverableMessageTable, 'ck_sync_state'),
};

// A recoverable message keeps its message row but is linked to its chat here.
export class RecoverableMessagesStream extends AppleMessagesStream<ChatMessageRow> {
  readonly name = 'recoverableMessages';
  readonly primaryKey = ['chatGuid', 'messageGuid'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per chat and message link in chat.db chat_recoverable_message_join, keyed by (chatGuid, messageGuid): a message recoverable after deletion keeps its messages record and is linked to its chat here instead of in chatMessages (observed on a live store; Apple does not document this table). chatGuid refers to chats.guid and messageGuid to messages.guid; the message's parts are in recoverableMessageParts. ${countAtMessageGrain} ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatMessageRow[] {
    return database.recoverableMessages();
  }

  protected accepts(row: ChatMessageRow, selection: MessageSelection): boolean {
    return selection.chat(row.chatGuid) && selection.message(row.messageGuid);
  }

  protected records(row: ChatMessageRow): Record<string, unknown>[] {
    return [
      {
        chatGuid: row.chatGuid,
        messageGuid: row.messageGuid,
        deleteDate: encode(row.values.delete_date ?? null),
        ckSyncState: encode(row.values.ck_sync_state ?? null),
      },
    ];
  }
}
