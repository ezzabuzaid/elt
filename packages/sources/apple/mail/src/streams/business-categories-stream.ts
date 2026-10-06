import { businessCategoriesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class BusinessCategoriesStream extends MailTableStream<
  typeof businessCategoriesTable
> {
  readonly name = 'businessCategories';

  constructor() {
    super(
      businessCategoriesTable,
      'One record per business category row in the local Mail index. Primary key id. business refers to businesses.id and is unique in the captured index schema.',
      {
        ROWID: 'Local business category row identifier.',
        business:
          'Refers to businesses.id within this source; unique in the captured index schema.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.business(record.business);
  }
}
