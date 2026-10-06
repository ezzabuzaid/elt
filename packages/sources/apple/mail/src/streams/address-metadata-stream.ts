import { addressMetadataTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class AddressMetadataStream extends MailTableStream<
  typeof addressMetadataTable
> {
  readonly name = 'addressMetadata';

  constructor() {
    super(
      addressMetadataTable,
      'One record per address metadata row in the local Mail index. Primary key id. address holds address text, unique in the captured index schema, and matches addresses.address, not addresses.id.',
      {
        ROWID: 'Local address metadata row identifier.',
        address:
          'Address text matching addresses.address within this source; the captured index schema compares both case-insensitively.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.addressText(record.address);
  }
}
