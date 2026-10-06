import { serverMessagesTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class ServerMessagesStream extends MailTableStream<
  typeof serverMessagesTable
> {
  readonly name = 'serverMessages';

  constructor() {
    super(
      serverMessagesTable,
      'One record per server message row, kept in a table separate from messages. Primary key id. message refers to messages.id and mailbox to mailboxes.id; (mailbox, remoteId) is unique in the captured index schema. Further mailbox memberships are in serverMessageMailboxes.',
      {
        ROWID:
          'Local server message identifier; serverMessageMailboxes.serverMessage refers to it within this source.',
        message:
          'Refers to messages.id within this source; the index sets it to NULL when that message row is deleted.',
        mailbox: 'Refers to mailboxes.id within this source.',
        remote_id: `${undocumented} Unique together with mailbox in the captured index schema.`,
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.serverMessage(record.id);
  }
}
