import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import { flag, type NotesScan, type Row, string } from './notes-scan.ts';

const { id, nullableId, text, ordinal, nullableText, boolean } = notesFields;

const properties = {
  id: {
    ...id,
    description:
      'Notes folder identifier; referenced by notes.folderId and folders.parentId within this source.',
  },
  accountId: {
    ...id,
    description:
      'Owning account identifier; refers to accounts.id within this source.',
  },
  parentId: {
    ...nullableId,
    description:
      'Parent folder identifier in folders.id within this source; NULL for a root folder.',
  },
  name: { ...text, description: 'Folder title displayed by Notes.' },
  type: {
    ...ordinal,
    description:
      'Numeric folder category stored by Notes. 1 means Recently Deleted; its notes remain exported until permanently deleted.',
  },
  smartQuery: {
    ...nullableText,
    description:
      'Smart-folder query as Notes stores it, encoded as JSON text; NULL when not recorded. It is source metadata, not executable SQL.',
  },
  shared: {
    ...boolean,
    description: 'Whether Notes stores sharing metadata for this folder.',
  },
} as const;

export class FoldersStream extends AppleNotesStream<typeof properties, Row> {
  readonly name = 'folders';
  readonly jsonSchema = notesSchema(
    properties,
    'One source record per local Notes folder, including nested folders, smart folders and Recently Deleted, excluding folders marked for deletion. Relationships name streams in this source, not physical destination tables.',
  );

  protected rows(scan: NotesScan): readonly Row[] {
    return scan.folders;
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      id: row.ZIDENTIFIER as string,
      accountId: row.account as string,
      parentId: string(row.parent),
      name: row.ZTITLE2 as string,
      type: row.ZFOLDERTYPE as number,
      smartQuery: string(row.ZSMARTFOLDERQUERYJSON),
      shared: flag(row.shared),
    };
  }
}
