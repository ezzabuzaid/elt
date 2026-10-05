import {
  type ChatDatabase,
  type ChatPartRow,
  chatServiceTable,
} from '@workspace/sdk-apple-messages';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import {
  chatGuid,
  columnField,
  encode,
  localStore,
} from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  chatGuid,
  service: columnField(chatServiceTable, 'service'),
};

export class ChatServicesStream extends AppleMessagesStream<ChatPartRow> {
  readonly name = 'chatServices';
  readonly primaryKey = ['chatGuid', 'service'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per chat and service pair in chat.db chat_service, keyed by (chatGuid, service). chatGuid refers to chats.guid. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatPartRow[] {
    return database.chatServices();
  }

  protected accepts(row: ChatPartRow, selection: MessageSelection): boolean {
    return selection.chat(row.chatGuid);
  }

  protected records(row: ChatPartRow): Record<string, unknown>[] {
    return [
      { chatGuid: row.chatGuid, service: encode(row.values.service ?? null) },
    ];
  }
}
