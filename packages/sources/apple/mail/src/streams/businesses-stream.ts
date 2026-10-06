import { businessesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class BusinessesStream extends MailTableStream<typeof businessesTable> {
  readonly name = 'businesses';

  constructor() {
    super(
      businessesTable,
      'One record per business row in the local Mail index. Primary key id. businessAddresses.business and businessCategories.business refer to id. The captured index schema requires each row to hold either addressComment and domain, or brandId and localizedBrandName, and leaves the other pair NULL.',
      {
        ROWID:
          'Local business identifier; businessAddresses.business and businessCategories.business refer to it within this source.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.business(record.id);
  }
}
