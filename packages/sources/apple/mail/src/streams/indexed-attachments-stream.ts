import { attachmentsTable } from '@workspace/sdk-apple-mail';

import type { MailSelection } from '../mail-selection.ts';
import { MailTableStream } from '../mail-table-stream.ts';

export class IndexedAttachmentsStream extends MailTableStream<
  typeof attachmentsTable
> {
  readonly name = 'indexedAttachments';

  constructor() {
    super(
      attachmentsTable,
      'One record per attachment Mail records in its index for a message, which can exist before the message file or the attachment file is downloaded. Primary key id. message refers to messages.id; (message, attachmentId) matches (messageId, partId) in attachments and, once the message file is local, in messageParts. This stream carries no bytes or availability; the attachments stream does.',
      {
        ROWID: 'Local index attachment row identifier.',
        message: 'Refers to messages.id within this source.',
        attachment_id:
          'MIME part number of the attachment, such as 2 or 1.2; equals partId in attachments and messageParts within this source.',
        name: 'Attachment name recorded by the index; attachments.filename uses it when the MIME part is not available locally.',
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
