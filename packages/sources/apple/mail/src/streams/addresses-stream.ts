import { addressesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class AddressesStream extends MailTableStream<typeof addressesTable> {
  readonly name = 'addresses';

  constructor() {
    super(
      addressesTable,
      'One record per distinct address and comment pair in the local Mail index; the captured index schema keeps each pair once. Primary key id. messages.sender, recipients.address, businessAddresses.address and senderAddresses.address refer to id; addressMetadata matches on the address text instead.',
      {
        ROWID:
          'Local address identifier. messages.sender, recipients.address, businessAddresses.address and senderAddresses.address refer to it within this source.',
        address:
          'Address text; the captured index schema compares it case-insensitively. addressMetadata.address holds the same text within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.address(record.id);
  }
}
