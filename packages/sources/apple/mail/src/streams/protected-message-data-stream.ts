import { protectedMessageDataTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class ProtectedMessageDataStream extends MailTableStream<
  typeof protectedMessageDataTable
> {
  readonly name = 'protectedMessageData';

  constructor() {
    super(
      protectedMessageDataTable,
      'One record per protected message data row in the local Mail index. Primary key id. data is an opaque native payload passed through as text. The source proves no owning message for these rows, so no join is stated and scoped imports omit this stream.',
      {
        ROWID: `${undocumented} Not proven to refer to any other stream, so no join is stated.`,
        data: `${undocumented} Opaque native payload passed through without interpretation.`,
      },
    );
  }

  // No proven account or message ownership: a scoped import omits these
  // records rather than copying unrelated data or guessing joins.
  protected accepts(): boolean {
    return false;
  }
}
