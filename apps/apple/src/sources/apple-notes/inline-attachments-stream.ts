import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import { type NotesScan, type Row, string, time } from './notes-scan.ts';

const { id, text, nullableText, nullableTimestamp } = notesFields;

// Tags, mentions, links to other notes and calculations sit inline in the
// text; target is what each points at (a tag's normalized name, a note).
const properties = {
  id,
  noteId: id,
  type: text,
  text: nullableText,
  target: nullableText,
  createdAt: nullableTimestamp,
} as const;

export class InlineAttachmentsStream extends AppleNotesStream<
  typeof properties,
  Row
> {
  readonly name = 'inlineAttachments';
  readonly jsonSchema = notesSchema(properties);

  protected rows(scan: NotesScan): readonly Row[] {
    return [...scan.inline.values()];
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      id: row.ZIDENTIFIER as string,
      noteId: row.note as string,
      type: row.ZTYPEUTI1 as string,
      text: string(row.ZALTTEXT),
      target: string(row.ZTOKENCONTENTIDENTIFIER),
      createdAt: time(row.ZCREATIONDATE2),
    };
  }
}
