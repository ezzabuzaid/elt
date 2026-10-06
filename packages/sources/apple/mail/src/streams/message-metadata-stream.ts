import { messageMetadataTable } from '@workspace/sdk-apple-mail';

import { undocumented } from '../mail-fields.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MessageMetadataStream extends MailTableStream<
  typeof messageMetadataTable
> {
  readonly name = 'messageMetadata';

  constructor() {
    super(
      messageMetadataTable,
      'One record per message metadata row in the local Mail index. Primary key messageId. The source proves no owning message for these rows, so no join is stated and scoped imports omit this stream. jsonValues is native JSON text passed through as data.',
      {
        message_id: `${undocumented} Not proven to refer to messages.id or messages.messageId, so no join is stated.`,
        json_values: `${undocumented} Native JSON text passed through without interpretation.`,
      },
    );
  }

  // No proven account or message ownership: a scoped import omits these
  // records rather than copying unrelated data or guessing joins.
  protected accepts(): boolean {
    return false;
  }
}
