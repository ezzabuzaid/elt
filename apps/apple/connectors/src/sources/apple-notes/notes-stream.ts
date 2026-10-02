import type { RecordDraft } from '@workspace/elt';

import { AppleNotesStream, notesFields } from './apple-notes-stream.ts';
import {
  type NoteEntry,
  type NotesScan,
  flag,
  string,
  time,
} from './notes-scan.ts';

const { id, nullableText, nullableTimestamp, boolean } = notesFields;

const properties = {
  id: {
    ...id,
    description:
      'Notes note identifier. Attachment noteId fields refer to this identifier within this source.',
  },
  accountId: {
    ...id,
    description:
      'Owning account identifier; refers to accounts.id within this source.',
  },
  folderId: {
    ...id,
    description:
      'Containing folder identifier; refers to folders.id within this source. A folder with type 1 is Recently Deleted.',
  },
  title: {
    ...nullableText,
    description:
      'Note title; NULL when absent. A locked note can still expose its title.',
  },
  text: {
    ...nullableText,
    description:
      'Visible plain text, including inline tags and mentions, with file placeholders removed. NULL when the note is locked or its body is unavailable.',
  },
  markdown: {
    ...nullableText,
    description:
      'Note body rendered as Markdown, including checklists and tables. attachment:<id> links refer to attachments.id within this source; applenotes: links refer to other notes. NULL when locked or the body is unavailable. Fonts, colors and underline are not represented.',
  },
  createdAt: {
    ...nullableTimestamp,
    description:
      'Creation time recorded by Notes, converted to a UTC instant; NULL when unavailable.',
  },
  modifiedAt: {
    ...nullableTimestamp,
    description:
      'Modification time recorded by Notes, converted to a UTC instant; NULL when unavailable. This is not the time of extraction or proof that all changes advanced this timestamp.',
  },
  pinned: {
    ...boolean,
    description: 'Whether Notes marks this note as pinned.',
  },
  hasChecklist: {
    ...boolean,
    description:
      'Notes reports that the note contains a checklist. This flag can be available even when a locked body cannot be read.',
  },
  checklistInProgress: {
    ...boolean,
    description:
      'Notes reports that a checklist is in progress; this is its stored flag, not a count of unfinished items.',
  },
  locked: {
    ...boolean,
    description:
      'Whether Notes marks the note as password protected. The connector does not decrypt it; text and markdown remain NULL.',
  },
  shared: {
    ...boolean,
    description: 'Whether Notes stores sharing metadata for this note.',
  },
} as const;

export class NotesStream extends AppleNotesStream<
  typeof properties,
  NoteEntry
> {
  readonly name = 'notes';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per note currently in the local Notes store with an account and folder. Includes locked notes and Recently Deleted; excludes cloud placeholders without a folder and records marked for deletion. Only Notes syncs remote changes to this Mac.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotesScan): readonly NoteEntry[] {
    return scan.notes;
  }

  // A locked note's body is encrypted: it keeps its title, dates and flags.
  protected record(
    { row, document }: NoteEntry,
    scan: NotesScan,
  ): RecordDraft<typeof properties> {
    return {
      id: row.ZIDENTIFIER,
      accountId: row.account,
      folderId: row.folder,
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
