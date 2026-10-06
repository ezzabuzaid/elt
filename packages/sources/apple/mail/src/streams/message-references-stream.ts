import { messageReferencesTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class MessageReferencesStream extends MailTableStream<
  typeof messageReferencesTable
> {
  readonly name = 'messageReferences';

  constructor() {
    super(
      messageReferencesTable,
      'One record per reference a message row carries. Primary key id. message refers to messages.id; reference is a Message-ID hash in the same space as messages.messageId and can match no messages row.',
      {
        ROWID: 'Local message reference row identifier.',
        message: 'Refers to messages.id within this source.',
        reference:
          'Message-ID hash in the same space as messages.messageId within this source; not enforced by the index, so it can match no messages row.',
      },
    );
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.message(record.message);
  }
}
