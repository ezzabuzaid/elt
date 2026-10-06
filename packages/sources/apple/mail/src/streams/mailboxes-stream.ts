import { mailboxesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MailboxesStream extends MailTableStream<typeof mailboxesTable> {
  readonly name = 'mailboxes';

  constructor() {
    super(
      mailboxesTable,
      'One record per mailbox row in the local Mail index, identified by its URL. Primary key id. Messages relate through messageMailboxes (many to many), messages.mailbox and messages.remoteMailbox; server messages through serverMessages.mailbox and serverMessageMailboxes.label. Count columns are passed through as stored, not recomputed from messages.',
      {
        ROWID:
          'Local mailbox identifier. messageMailboxes.mailboxId, messages.mailbox, messages.remoteMailbox, serverMessages.mailbox and serverMessageMailboxes.label refer to it within this source.',
        url: 'Mailbox URL, unique in the captured index schema. Its host matches accounts.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.mailbox(record.id);
  }
}
