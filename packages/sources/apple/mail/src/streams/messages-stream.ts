import { messagesTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MessagesStream extends MailTableStream<typeof messagesTable> {
  readonly name = 'messages';

  constructor() {
    super(
      messagesTable,
      'One record per message row in the local Mail index, across all accounts. Primary key id. Mailbox membership is its own grain: messageMailboxes holds message and mailbox pairs beside messages.mailbox and messages.remoteMailbox. subject, summary and sender hold identifiers that need explicit joins to subjects.id, summaries.id and addresses.id, and recipients are rows of recipients. The index declares no foreign keys for these references; they follow how this source reads the index, and a live store resolved every one. Bodies and headers are in messageParts and messageHeaders; whether the message file is on this Mac is in messageFiles.',
      {
        ROWID:
          'Local message identifier. messageMailboxes.messageId, recipients.message, indexedAttachments.message, serverMessages.message, messageReferences.message, events.messageId, messageFiles.messageId, messageHeaders.messageId, messageParts.messageId and attachments.messageId refer to it within this source.',
        message_id:
          "Hash Mail stores for the message's Message-ID, not this stream's id. conversationMessages.messageId and messageGlobalData.messageId hold the same hash within this source. It is not unique in the captured index schema, so a join on it can match several messages rows.",
        global_message_id:
          'Refers to messageGlobalData.id within this source; the captured index schema does not make it unique.',
        sender:
          'Refers to addresses.id within this source, which holds the address text.',
        subject:
          'Refers to subjects.id within this source, which holds the subject text.',
        summary:
          'Refers to summaries.id within this source, which holds the summary text.',
        mailbox:
          'Refers to mailboxes.id within this source. A message can belong to further mailboxes through messageMailboxes.',
        remote_mailbox: 'Refers to mailboxes.id within this source.',
        conversation_id: `${undocumented} This source relates messages to conversations through conversationMessages, not this column.`,
        brand_indicator: 'Refers to brandIndicators.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.message(record.id);
  }
}
