import { businessAddressesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class BusinessAddressesStream extends MailTableStream<
  typeof businessAddressesTable
> {
  readonly name = 'businessAddresses';

  constructor() {
    super(
      businessAddressesTable,
      'One record per address assigned to a business. Primary key id. address refers to addresses.id, unique in the captured index schema, and business refers to businesses.id.',
      {
        ROWID: 'Local business address row identifier.',
        address:
          'Refers to addresses.id within this source; unique in the captured index schema.',
        business: 'Refers to businesses.id within this source.',
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
