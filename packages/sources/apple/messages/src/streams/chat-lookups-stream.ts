import {
  type ChatDatabase,
  type ChatPartRow,
  chatLookupTable,
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
  identifier: columnField(chatLookupTable, 'identifier'),
  domain: columnField(chatLookupTable, 'domain'),
  chatGuid,
  priority: columnField(chatLookupTable, 'priority'),
};

// chat.db's chat_lookup rows, unique per identifier and domain.
export class ChatLookupsStream extends AppleMessagesStream<ChatPartRow> {
  readonly name = 'chatLookups';
  readonly primaryKey = ['identifier', 'domain'];
  readonly jsonSchema = {
    type: 'object',
    description: `One record per row of chat.db chat_lookup, keyed by (identifier, domain), which chat.db keeps unique; what a lookup means is not documented by Apple. chatGuid refers to chats.guid. ${localStore}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(database: ChatDatabase): readonly ChatPartRow[] {
    return database.chatLookups();
  }

  protected accepts(row: ChatPartRow, selection: MessageSelection): boolean {
    return selection.chat(row.chatGuid);
  }

  protected records(row: ChatPartRow): Record<string, unknown>[] {
    return [
      {
        identifier: encode(row.values.identifier ?? null),
        domain: encode(row.values.domain ?? null),
        chatGuid: row.chatGuid,
        priority: encode(row.values.priority ?? null),
      },
    ];
  }
}
