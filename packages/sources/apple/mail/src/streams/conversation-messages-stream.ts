import { conversationMessagesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class ConversationMessagesStream extends MailTableStream<
  typeof conversationMessagesTable
> {
  readonly name = 'conversationMessages';

  constructor() {
    super(
      conversationMessagesTable,
      'One record per conversation and message membership. Primary key (conversationId, messageId). conversationId refers to conversations.conversationId; messageId is the Message-ID hash in messages.messageId, not messages.id. That hash is not unique in messages, so a join can match several messages rows: count at message grain.',
      {
        conversation_id:
          'Refers to conversations.conversationId within this source.',
        message_id:
          'Message-ID hash; matches messages.messageId within this source, not messages.id.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.messageHash(record.messageId);
  }
}
