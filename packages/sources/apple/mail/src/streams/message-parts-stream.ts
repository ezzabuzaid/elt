import { type MailFile, readMailMime } from '@workspace/sdk-apple-mail';

import { type MailEntry, mailSchema } from '../apple-mail-stream.ts';
import {
  described,
  localMessageId,
  nullableText,
  partFields,
  partId,
  sha256,
} from '../mail-fields.ts';
import {
  MailMessageStream,
  indexedParts,
  partRecord,
} from '../mail-message-stream.ts';
import type { MailScan } from '../mail-scan.ts';

export class MessagePartsStream extends MailMessageStream {
  readonly name = 'messageParts';
  readonly primaryKey = ['messageId', 'partId'];
  readonly jsonSchema = mailSchema(
    'One record per MIME part, including multipart containers, of each locally available message file. Primary key (messageId, partId). parentPartId links a part to its container: join (messageId, parentPartId) to messageParts (messageId, partId). Messages without a local file have no rows (see messageFiles). A detached part whose separate file is missing stays as a row with availableLocally false. An attached message/rfc822 is one part; its inner parts are not expanded.',
    described(
      { ...partFields, text: nullableText },
      {
        messageId: localMessageId,
        partId,
        parentPartId:
          'partId of the containing multipart part; join (messageId, parentPartId) to messageParts (messageId, partId). NULL for the root part.',
        contentType:
          'Media type as parsed from Content-Type by the MIME parser, which supplies its own default when the header is absent; NULL when the parser reports none.',
        charset: 'Charset parameter of Content-Type; NULL when absent.',
        transferEncoding:
          'Content-Transfer-Encoding value; NULL when absent or empty.',
        disposition:
          'Content-Disposition type, such as attachment or inline; NULL when absent.',
        filename:
          "Filename as parsed from the part's headers by the MIME parser; NULL when absent.",
        contentId: 'Content-ID header value; NULL when absent.',
        isMultipart:
          'Whether the part is a multipart container; containers carry no decoded bytes.',
        isAttachment:
          'True when indexedAttachments lists this part, or when a non-multipart part has a filename, an attachment disposition, is an attached message or has a media type other than text/*.',
        declaredBytes:
          "Byte count from the part's X-Apple-Content-Length header; NULL when absent. A part with this count and an empty body is read from its separate file under the message's Attachments directory.",
        decodedBytes:
          'Bytes after transfer decoding, or the size of the separate file for a detached part; NULL for multipart containers and for detached parts whose file is missing.',
        availableLocally:
          'False only for a detached part whose separate file is missing on this Mac; true otherwise, including multipart containers.',
        sha256: `${sha256} after transfer decoding, or of the separate file for a detached part; NULL for multipart containers and missing detached parts.`,
        text: 'Text of a text/* part decoded with its charset (UTF-8 when none is declared), including a detached part read from its separate file; NULL for other media types, multipart containers and missing detached parts. Decoded from the message itself; no document parser is applied.',
      },
    ),
  );

  protected readsWithoutFile(): boolean {
    return false;
  }

  // Every part is decoded; text/* parts as text, nothing staged.
  protected async *messageEntries(
    scan: MailScan,
    id: string,
    file: MailFile | undefined,
  ): AsyncGenerator<MailEntry, void, undefined> {
    if (file === undefined) return;
    const unclaimed = indexedParts(scan, id);
    const { parts } = await readMailMime(scan.snapshot.files, id, file, {
      headers: false,
      decode: () => true,
      stage: null,
    });
    for (const part of parts) {
      const indexed = unclaimed.delete(part.id);
      yield {
        data: {
          ...partRecord(id, part, part.isAttachment || indexed),
          text: part.text,
        },
        file: null,
      };
    }
  }
}
