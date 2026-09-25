import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import {
  flag,
  type NoteEntry,
  type NotesScan,
  string,
  time,
} from './notes-scan.ts';

const { id, nullableText, nullableTimestamp, boolean } = notesFields;

const properties = {
  id,
  accountId: id,
  folderId: id,
  title: nullableText,
  text: nullableText,
  markdown: nullableText,
  createdAt: nullableTimestamp,
  modifiedAt: nullableTimestamp,
  pinned: boolean,
  hasChecklist: boolean,
  checklistInProgress: boolean,
  locked: boolean,
  shared: boolean,
} as const;

export class NotesStream extends AppleNotesStream<
  typeof properties,
  NoteEntry
> {
  readonly name = 'notes';
  readonly jsonSchema = notesSchema(properties);

  protected rows(scan: NotesScan): readonly NoteEntry[] {
    return scan.notes;
  }

  // A locked note's body is encrypted: it keeps its title, dates and flags.
  protected record(
    { row, document }: NoteEntry,
    scan: NotesScan,
  ): SchemaRecord<typeof properties> {
    return {
      id: row.ZIDENTIFIER as string,
      accountId: row.account as string,
      folderId: row.folder as string,
      title: string(row.ZTITLE1),
      text: document === null ? null : scan.text(document),
      markdown: document === null ? null : scan.markdown(document),
      createdAt: time(row.ZCREATIONDATE3),
      modifiedAt: time(row.ZMODIFICATIONDATE1),
      pinned: flag(row.ZISPINNED),
      hasChecklist: flag(row.ZHASCHECKLIST),
      checklistInProgress: flag(row.ZHASCHECKLISTINPROGRESS),
      locked: flag(row.ZISPASSWORDPROTECTED),
      shared: flag(row.shared),
    };
  }
}
