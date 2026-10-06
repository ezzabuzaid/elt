import { senderAddressesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class SenderAddressesStream extends MailTableStream<
  typeof senderAddressesTable
> {
  readonly name = 'senderAddresses';

  constructor() {
    super(
      senderAddressesTable,
      'One record per address assigned to a sender. Primary key address. address refers to addresses.id and sender to senders.id; each address has at most one sender.',
      {
        address: 'Refers to addresses.id within this source.',
        sender: 'Refers to senders.id within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.address(record.address);
  }
}
