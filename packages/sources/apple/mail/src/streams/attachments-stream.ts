import { rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

import type { RecordDraft, SnapshotGroup } from '@workspace/elt';
import {
  type IndexedAttachment,
  type MailFile,
  type MimePart,
  readMailMime,
} from '@workspace/sdk-apple-mail';

import { type MailEntry, mailSchema } from '../apple-mail-stream.ts';
import {
  described,
  localMessageId,
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

// A staged part's extension, which names the file a destination stores: the
// filename's, else one for its text type.
function extension(part: MimePart): string {
  if (part.filename !== null) return extname(part.filename);
  if (part.contentType === 'text/html') return '.html';
  return part.contentType !== null && part.contentType.startsWith('text/')
    ? '.txt'
    : '';
}

// Attachments the index knows before their message or MIME file arrives.
async function* indexedEntries(
  scan: MailScan,
  rows: Iterable<IndexedAttachment>,
): AsyncGenerator<MailEntry, void, undefined> {
  for (const row of rows) {
    const file = scan.snapshot.files.indexedFile(row);
    const record: RecordDraft<typeof partFields> = {
      messageId: row.message,
      partId: row.attachmentId,
      parentPartId: null,
      contentType: null,
      charset: null,
      transferEncoding: null,
      disposition: null,
      filename: row.name,
      contentId: null,
      isMultipart: false,
      isAttachment: true,
      declaredBytes: null,
      decodedBytes: file === undefined ? null : file.size,
      availableLocally: file !== undefined,
      sha256: file === undefined ? null : await file.hash(),
    };
    let path: string | null = null;
    if (file !== undefined) {
      path = join(
        scan.scratch,
        `indexed-${row.message}-${String(row.attachmentId)}${extname(file.path)}`,
      );
      await file.copyTo(path);
    }
    try {
      yield { data: record, file: path };
    } finally {
      if (path !== null) await rm(path);
    }
  }
}

export class AttachmentsStream extends MailMessageStream {
  readonly name = 'attachments';
  readonly primaryKey = ['messageId', 'partId'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = mailSchema(
    'One record per attachment: each MIME part with isAttachment true in a locally available message file, plus each indexedAttachments row whose part was not found in one (index-only rows). Index attachment metadata can exist before the message or attachment file is downloaded. Primary key (messageId, partId), the same key as messageParts and as (message, attachmentId) in indexedAttachments. Index-only rows have NULL MIME fields. availableLocally tells whether the bytes are on this Mac; the transferred file is the decoded attachment, and an attached message stays one complete file.',
    described(partFields, {
      messageId: localMessageId,
      partId,
      parentPartId:
        'partId of the containing multipart part; join (messageId, parentPartId) to messageParts (messageId, partId). NULL for a root part and for index-only rows.',
      contentType:
        'Media type as parsed from Content-Type by the MIME parser; NULL for index-only rows or when the parser reports none.',
      charset:
        'Charset parameter of Content-Type; NULL when absent or for index-only rows.',
      transferEncoding:
        'Content-Transfer-Encoding value; NULL when absent, empty or for index-only rows.',
      disposition:
        'Content-Disposition type, such as attachment or inline; NULL when absent or for index-only rows.',
      filename:
        "Filename as parsed from the part's headers by the MIME parser; for index-only rows, the name in indexedAttachments.name. NULL when neither exists.",
      contentId:
        'Content-ID header value; NULL when absent or for index-only rows.',
      isMultipart:
        'Whether the part is a multipart container; false for index-only rows.',
      isAttachment: 'Always true in this stream.',
      declaredBytes:
        "Byte count from the part's X-Apple-Content-Length header; NULL when absent or for index-only rows.",
      decodedBytes:
        "Bytes after transfer decoding, or the size of the separate file under the message's Attachments directory; NULL when the bytes are not on this Mac.",
      availableLocally:
        'Whether the attachment bytes are on this Mac. False for a detached or index-only attachment whose file has not been downloaded; a later run updates the row once the file appears.',
      sha256: `${sha256} of the attachment; NULL when the bytes are not on this Mac.`,
    }),
  );

  // A message whose file has not arrived still has the attachments its index
  // rows name.
  protected readsWithoutFile(
    id: string,
    indexed: ReadonlyMap<string, IndexedAttachment[]>,
  ): boolean {
    return indexed.has(id);
  }

  // Each attachment part is staged in the scan's storage and removed once the
  // consumer reads its record; index rows no part claims follow.
  protected async *messageEntries(
    scan: MailScan,
    id: string,
    file: MailFile | undefined,
  ): AsyncGenerator<MailEntry, void, undefined> {
    const unclaimed = indexedParts(scan, id);
    if (file !== undefined) {
      const { parts } = await readMailMime(scan.snapshot.files, id, file, {
        headers: false,
        decode: (part) => part.isAttachment || unclaimed.has(part.id),
        stage: (part) =>
          join(scan.scratch, `${id}-${part.id}${extension(part)}`),
      });
      try {
        for (const part of parts) {
          const indexed = unclaimed.delete(part.id);
          if (part.isAttachment || indexed)
            yield { data: partRecord(id, part, true), file: part.file };
        }
      } finally {
        for (const part of parts) if (part.file !== null) await rm(part.file);
      }
    }
    yield* indexedEntries(scan, unclaimed.values());
  }

  // The index can know an attachment of a message it no longer lists.
  protected override async *unlisted(
    scan: MailScan,
    listed: ReadonlySet<string>,
  ): AsyncGenerator<SnapshotGroup<MailEntry>, void, undefined> {
    for (const [id, rows] of scan.messageInputs().indexed)
      if (!listed.has(id))
        yield {
          key: id,
          fingerprint: scan.fingerprint(id, undefined),
          records: () => indexedEntries(scan, rows),
        };
  }
}
