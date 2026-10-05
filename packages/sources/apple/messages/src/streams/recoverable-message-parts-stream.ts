import {
  type ChatDatabase,
  type RecoverablePartRow,
  recoverablePartTable,
} from '@workspace/sdk-apple-messages';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  chatGuid,
  columnField,
  encode,
  localStore,
  messageGuid,
  unverified,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  chatGuid,
  messageGuid,
  partIndex: {
    ...eventKitFields.integer,
    description: `chat.db recoverable_message_part.part_index: integer passed through unchanged. ${unverified}`,
  },
  deleteDate: columnField(recoverablePartTable, 'delete_date'),
  partText: columnField(recoverablePartTable, 'part_text'),
  ckSyncState: columnField(recoverablePartTable, 'ck_sync_state'),
};

export class RecoverableMessagePartsStream extends AppleMessagesStream<RecoverablePartRow> {
  readonly name = 'recoverableMessageParts';
  readonly primaryKey = ['chatGuid', 'messageGuid', 'partIndex'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per message part in chat.db recoverable_message_part, for messages recoverable after deletion, keyed by (chatGuid, messageGuid, partIndex). chatGuid refers to chats.guid and messageGuid to messages.guid; (chatGuid, messageGuid) joins recoverableMessages. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly RecoverablePartRow[] {
    return database.recoverableMessageParts();
  }

  protected accepts(
    row: RecoverablePartRow,
    selection: MessageSelection,
  ): boolean {
    return selection.chat(row.chatGuid) && selection.message(row.messageGuid);
  }

  protected records(row: RecoverablePartRow): Record<string, unknown>[] {
    return [
      {
        chatGuid: row.chatGuid,
        messageGuid: row.messageGuid,
        partIndex: row.partIndex,
        deleteDate: encode(row.values.delete_date ?? null),
        partText: encode(row.values.part_text ?? null),
        ckSyncState: encode(row.values.ck_sync_state ?? null),
      },
    ];
  }
}
