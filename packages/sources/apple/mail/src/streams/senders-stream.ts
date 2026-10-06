import { sendersTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class SendersStream extends MailTableStream<typeof sendersTable> {
  readonly name = 'senders';

  constructor() {
    super(
      sendersTable,
      'One record per sender row in the local Mail index. Primary key id. senderAddresses.sender refers to id; contactIdentifier is unique in the captured index schema.',
      {
        ROWID:
          'Local sender identifier; senderAddresses.sender refers to it within this source.',
        contact_identifier: `${undocumented} Unique in the captured index schema.`,
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.sender(record.id);
  }
}
