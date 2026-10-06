import { labelsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MessageMailboxesStream extends MailTableStream<
  typeof labelsTable
> {
  readonly name = 'messageMailboxes';

  constructor() {
    super(
      labelsTable,
      'One record per message and mailbox membership; a message can belong to several mailboxes. Primary key (messageId, mailboxId). messageId refers to messages.id and mailboxId to mailboxes.id. Joining messages through this stream repeats a message once per mailbox: count at message grain.',
      {
        message_id:
          'Refers to messages.id within this source (the local id, not the hash in messages.messageId).',
        mailbox_id: 'Refers to mailboxes.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return (
      selection.message(record.messageId) && selection.mailbox(record.mailboxId)
    );
  }
}
