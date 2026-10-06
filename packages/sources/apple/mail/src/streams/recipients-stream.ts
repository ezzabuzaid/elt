import { recipientsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class RecipientsStream extends MailTableStream<typeof recipientsTable> {
  readonly name = 'recipients';

  constructor() {
    super(
      recipientsTable,
      'One record per address in one recipient position of one message. Primary key id. message refers to messages.id and address to addresses.id; the captured index schema keeps (message, type, position) unique and does not enforce message, so rows whose message is gone are kept. A message has many recipients: count messages at message grain (distinct message) after joining.',
      {
        ROWID: 'Local recipient row identifier.',
        message:
          'Refers to messages.id within this source; not enforced by the index, so it can match no message.',
        address: 'Refers to addresses.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.message(record.message);
  }
}
