import type {
  ChatDatabase,
  ChatHandleRow,
} from '@workspace/sdk-apple-messages';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleMessagesStream } from '../apple-messages-stream.ts';
import { chatGuid, localStore } from '../messages-fields.ts';
import type { MessageSelection } from '../messages-scan.ts';

const properties = {
  chatGuid,
  handleId: {
    ...eventKitFields.text,
    description:
      'chat.db handle.id of the linked handle; together with handleService refers to handles (id, service) within this source.',
  },
  handleService: {
    ...eventKitFields.text,
    description:
      'chat.db handle.service of the linked handle; together with handleId refers to handles (id, service) within this source.',
  },
};

export class ChatHandlesStream extends AppleMessagesStream<ChatHandleRow> {
  readonly name = 'chatHandles';
  readonly primaryKey = ['chatGuid', 'handleId', 'handleService'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per handle linked to a chat in chat.db chat_handle_join, keyed by (chatGuid, handleId, handleService). chatGuid refers to chats.guid; handleId and handleService together join handles.id and handles.service. A chat can link many handles and a handle many chats. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatHandleRow[] {
    return database.chatHandles();
  }

  protected accepts(row: ChatHandleRow, selection: MessageSelection): boolean {
    return selection.chat(row.chatGuid);
  }

  protected records(row: ChatHandleRow): Record<string, unknown>[] {
    return [
      {
        chatGuid: row.chatGuid,
        handleId: row.handle.id,
        handleService: row.handle.service,
      },
    ];
  }
}
