import { access } from 'node:fs/promises';
import type { SQLOutputValue } from 'node:sqlite';
import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import {
  type NotesScan,
  number,
  type Row,
  string,
  time,
} from './notes-scan.ts';

const {
  id,
  nullableId,
  text,
  nullableText,
  ordinal,
  nullableNumber,
  nullableTimestamp,
  boolean,
} = notesFields;

const properties = {
  id,
  noteId: id,
  parentId: nullableId,
  type: text,
  title: nullableText,
  filename: nullableText,
  url: nullableText,
  summary: nullableText,
  ocrText: nullableText,
  handwritingText: nullableText,
  imageLabels: nullableText,
  transcript: nullableText,
  fileSize: ordinal,
  duration: nullableNumber,
  width: nullableNumber,
  height: nullableNumber,
  latitude: { type: ['number', 'null'], minimum: -90, maximum: 90 },
  longitude: { type: ['number', 'null'], minimum: -180, maximum: 180 },
  createdAt: nullableTimestamp,
  modifiedAt: nullableTimestamp,
  // Changes when an iCloud file downloads, so the diff reloads its bytes.
  availableLocally: boolean,
} as const;

type Attachment = SchemaRecord<typeof properties>;

export class AttachmentsStream extends AppleNotesStream<
  typeof properties,
  Row
> {
  readonly name = 'attachments';
  readonly jsonSchema = notesSchema(properties);
  readonly supportsFileTransfer = true;

  protected rows(scan: NotesScan): readonly Row[] {
    return [...scan.attachments.values()];
  }

  protected async record(row: Row, scan: NotesScan): Promise<Attachment> {
    // A locked note's attachments keep only what the list of attachments
    // shows, not what they contain.
    const content = (value: SQLOutputValue | undefined) =>
      row.locked === 1 ? null : string(value);
    const file = scan.file(row);
    return {
      id: row.ZIDENTIFIER as string,
      noteId: row.note as string,
      parentId: string(row.parent),
      type: string(row.ZTYPEUTI) ?? 'public.data',
      title: string(row.title),
      filename: string(row.ZFILENAME),
      url: content(row.ZURLSTRING),
      summary: content(row.ZSUMMARY),
      ocrText: content(row.ZOCRSUMMARY),
      handwritingText: content(row.ZHANDWRITINGSUMMARY),
      imageLabels: content(row.ZIMAGECLASSIFICATIONSUMMARY),
      transcript: content(row.ZADDITIONALINDEXABLETEXT),
      fileSize: number(row.ZFILESIZE) ?? 0,
      duration: number(row.ZDURATION) || null,
      width: number(row.ZSIZEWIDTH) || null,
      height: number(row.ZSIZEHEIGHT) || null,
      latitude: number(row.ZLATITUDE),
      longitude: number(row.ZLONGITUDE),
      createdAt: time(row.ZCREATIONDATE),
      modifiedAt: time(row.ZMODIFICATIONDATE),
      availableLocally:
        file !== null &&
        (await access(file).then(
          () => true,
          () => false,
        )),
    };
  }

  // The original file, not a staged copy: readers only read it.
  override file(record: Attachment, scan: NotesScan): string | null {
    const row = scan.attachments.get(record.id);
    return record.availableLocally && row !== undefined ? scan.file(row) : null;
  }
}
