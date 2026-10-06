import { conversationsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class ConversationsStream extends MailTableStream<
  typeof conversationsTable
> {
  readonly name = 'conversations';

  constructor() {
    super(
      conversationsTable,
      'One record per conversation row in the local Mail index. Primary key conversationId. Messages belong to conversations through conversationMessages.',
      {
        conversation_id:
          'Local conversation identifier; conversationMessages.conversationId refers to it within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.conversation(record.conversationId);
  }
}
