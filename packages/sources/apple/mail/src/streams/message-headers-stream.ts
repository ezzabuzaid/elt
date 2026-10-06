import { type MailFile, readMailMime } from '@workspace/sdk-apple-mail';

import { type MailEntry, mailSchema } from '../apple-mail-stream.ts';
import {
  described,
  headersFields,
  localMessageId,
  partId,
} from '../mail-fields.ts';
import { MailMessageStream } from '../mail-message-stream.ts';
import type { MailScan } from '../mail-scan.ts';

export class MessageHeadersStream extends MailMessageStream {
  readonly name = 'messageHeaders';
  readonly primaryKey = ['messageId', 'partId', 'position'];
  readonly jsonSchema = mailSchema(
    'One record per header line of each MIME part of a locally available message file, in stored order; repeated header names stay separate rows. Primary key (messageId, partId, position). (messageId, partId) joins to messageParts (messageId, partId). Messages without a local file have no rows. An attached message/rfc822 is one part; its inner headers are not split out.',
    described(headersFields, {
      messageId: localMessageId,
      partId: `${partId} Joins to messageParts.partId with messageId.`,
      position:
        "Zero-based position of the header within its part's header block, preserving the stored order.",
      name: 'Header name as keyed by the MIME parser, in lowercase.',
      value:
        'Header value with folded lines joined and encoded words decoded to text; the original line is in rawLineBase64.',
      rawLineBase64:
        'Bytes of the whole header line as the MIME parser keeps it, including folded continuation lines joined with CRLF, as Base64.',
    }),
  );

  protected readsWithoutFile(): boolean {
    return false;
  }

  protected async *messageEntries(
    scan: MailScan,
    id: string,
    file: MailFile | undefined,
  ): AsyncGenerator<MailEntry, void, undefined> {
    if (file === undefined) return;
    const { headers } = await readMailMime(scan.snapshot.files, id, file, {
      headers: true,
      decode: () => false,
      stage: null,
    });
    for (const header of headers)
      yield {
        data: {
          messageId: id,
          partId: header.partId,
          position: header.position,
          name: header.name,
          value: header.value,
          rawLineBase64: Buffer.from(header.rawLine).toString('base64'),
        },
        file: null,
      };
  }
}
