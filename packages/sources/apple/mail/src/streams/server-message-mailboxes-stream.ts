import { serverLabelsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class ServerMessageMailboxesStream extends MailTableStream<
  typeof serverLabelsTable
> {
  readonly name = 'serverMessageMailboxes';

  constructor() {
    super(
      serverLabelsTable,
      'One record per server message and mailbox membership. Primary key (serverMessage, label). serverMessage refers to serverMessages.id and label to mailboxes.id. Joining through this stream repeats a server message once per mailbox: count at server message grain.',
      {
        server_message: 'Refers to serverMessages.id within this source.',
        label: 'Refers to mailboxes.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return (
      selection.serverMessage(record.serverMessage) &&
      selection.mailbox(record.label)
    );
  }
}
