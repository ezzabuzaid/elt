import type {
  RecordDraft,
  SnapshotGroup,
  SourceMessage,
  Stream,
} from '@workspace/elt';
import { diffGroupedSnapshot } from '@workspace/elt';
import type {
  IndexedAttachment,
  MailFile,
  MimePart,
} from '@workspace/sdk-apple-mail';

import {
  AppleMailStream,
  type MailEntry,
  type MailRecords,
} from './apple-mail-stream.ts';
import type { partFields } from './mail-fields.ts';
import type { MailScan } from './mail-scan.ts';
import type { MailSelection } from './mail-selection.ts';

// A stream read from each message's files, as one snapshot group per
// message: a message whose inputs are unchanged keeps its saved records
// without being read.
export abstract class MailMessageStream extends AppleMailStream {
  // One group per selected message, in index order. Selection runs on every
  // scan; only reading a message whose inputs are unchanged is skipped.
  async *#groups(
    scan: MailScan,
  ): AsyncGenerator<SnapshotGroup<MailEntry>, void, undefined> {
    const inputs = scan.messageInputs();
    const listed = new Set<string>();
    for (const id of scan.snapshot.index.messageIds()) {
      if (scan.selection !== null && !scan.selection.message(id)) continue;
      listed.add(id);
      const file = scan.snapshot.files.messages.get(id);
      if (file === undefined && !this.readsWithoutFile(id, inputs.indexed))
        continue;
      yield {
        key: id,
        fingerprint: scan.fingerprint(id, file),
        records: () => this.messageEntries(scan, id, file),
      };
    }
    yield* this.unlisted(scan, listed);
  }

  protected override snapshot(
    stream: Stream,
    scan: MailScan,
    records: MailRecords,
    state: unknown,
  ): AsyncIterable<SourceMessage> {
    return diffGroupedSnapshot(stream, this.#accepted(scan, records), state);
  }

  protected async *entries(
    scan: MailScan,
  ): AsyncGenerator<MailEntry, void, undefined> {
    for await (const group of this.#groups(scan)) yield* group.records();
  }

  protected accepts(
    record: Record<string, unknown>,
    selection: MailSelection,
  ): boolean {
    return selection.message(record.messageId);
  }

  // Whether a message with no file on this Mac still has records.
  protected abstract readsWithoutFile(
    id: string,
    indexed: ReadonlyMap<string, IndexedAttachment[]>,
  ): boolean;

  // A message's entries, read from its files.
  protected abstract messageEntries(
    scan: MailScan,
    id: string,
    file: MailFile | undefined,
  ): AsyncGenerator<MailEntry, void, undefined>;

  // Groups for messages the index no longer lists.
  protected async *unlisted(
    _scan: MailScan,
    _listed: ReadonlySet<string>,
  ): AsyncGenerator<SnapshotGroup<MailEntry>, void, undefined> {}

  async *#accepted(
    scan: MailScan,
    records: MailRecords,
  ): AsyncGenerator<SnapshotGroup<Record<string, unknown>>, void, undefined> {
    for await (const group of this.#groups(scan))
      yield {
        key: group.key,
        fingerprint: group.fingerprint,
        records: () => records(group.records()),
      };
  }
}

// A MIME part as messageParts and attachments record it.
export const partRecord = (
  messageId: string,
  part: MimePart,
  isAttachment: boolean,
): RecordDraft<typeof partFields> => ({
  messageId,
  partId: part.id,
  parentPartId: part.parentId,
  contentType: part.contentType,
  charset: part.charset,
  transferEncoding: part.transferEncoding,
  disposition: part.disposition,
  filename: part.filename,
  contentId: part.contentId,
  isMultipart: part.isMultipart,
  isAttachment,
  declaredBytes: part.declaredBytes,
  decodedBytes: part.decodedBytes,
  availableLocally: part.availableLocally,
  sha256: part.sha256,
});

// A message's index attachment rows by part, which its MIME parts claim as
// they are read; an indexed part is an attachment whatever its headers say.
export const indexedParts = (scan: MailScan, id: string) =>
  new Map(
    (scan.messageInputs().indexed.get(id) ?? []).map((row) => [
      String(row.attachmentId),
      row,
    ]),
  );
