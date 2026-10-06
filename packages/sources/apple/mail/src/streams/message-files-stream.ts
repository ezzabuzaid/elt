import type { SchemaRecord } from '@workspace/elt';
import type { MailFile } from '@workspace/sdk-apple-mail';

import { type MailEntry, mailSchema } from '../apple-mail-stream.ts';
import {
  described,
  fileFields,
  localMessageId,
  sha256,
} from '../mail-fields.ts';
import { MailMessageStream } from '../mail-message-stream.ts';
import type { MailScan } from '../mail-scan.ts';

export class MessageFilesStream extends MailMessageStream {
  readonly name = 'messageFiles';
  readonly primaryKey = ['messageId'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = mailSchema(
    "One record per messages row, describing its EMLX message file on this Mac. Primary key messageId. The row exists even when no file is present: availableLocally is false and the file fields are NULL. EMLX files that no messages row names are not included. The transferred file is the original EMLX bytes, including Mail's leading byte count line and trailing property list.",
    described(fileFields, {
      messageId: localMessageId,
      relativePath:
        'Path of <id>.emlx or <id>.partial.emlx relative to the current Mail version directory; NULL when no file is present.',
      availableLocally:
        'Whether an EMLX file for this message was present when the run read the store. False does not mean the message was deleted.',
      partial:
        'True when the file is named <id>.partial.emlx, false when <id>.emlx; NULL when no file is present. This source does not interpret the name further; detached attachment bytes are resolved in messageParts and attachments.',
      size: 'Size of the EMLX file in bytes; NULL when no file is present.',
      sha256: `${sha256} of the whole EMLX file; NULL when no file is present.`,
    }),
  );

  protected readsWithoutFile(): boolean {
    return true;
  }

  // The transferred file is checked again once the consumer has read it.
  protected async *messageEntries(
    scan: MailScan,
    id: string,
    file: MailFile | undefined,
  ): AsyncGenerator<MailEntry, void, undefined> {
    const data: SchemaRecord<typeof fileFields> = {
      messageId: id,
      relativePath:
        file === undefined ? null : scan.snapshot.files.relative(file),
      availableLocally: file !== undefined,
      partial: file === undefined ? null : file.path.endsWith('.partial.emlx'),
      size: file === undefined ? null : file.size,
      sha256: file === undefined ? null : await file.hash(),
    };
    yield { data, file: file === undefined ? null : file.path };
    if (file !== undefined) await file.assertUnchanged();
  }
}
