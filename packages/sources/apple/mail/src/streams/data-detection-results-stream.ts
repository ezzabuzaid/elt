import { dataDetectionResultsTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class DataDetectionResultsStream extends MailTableStream<
  typeof dataDetectionResultsTable
> {
  readonly name = 'dataDetectionResults';

  constructor() {
    super(
      dataDetectionResultsTable,
      'One record per detection result row in the local Mail index: a category and value. Primary key id. (globalMessageId, category, value) is unique in the captured index schema. The source proves no owning message for these rows, so no join is stated and scoped imports omit this stream.',
      {
        ROWID: 'Local detection result row identifier.',
        global_message_id: `${undocumented} Not proven to refer to messageGlobalData.id, so no join is stated.`,
      },
    );
  }

  // No proven account or message ownership: a scoped import omits these
  // records rather than copying unrelated data or guessing joins.
  protected accepts(): boolean {
    return false;
  }
}
