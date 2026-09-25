import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import { flag, type NotesScan, type Row, string } from './notes-scan.ts';

const { id, nullableId, text, ordinal, nullableText, boolean } = notesFields;

// type 1 is Recently Deleted; parentId nests folders.
const properties = {
  id,
  accountId: id,
  parentId: nullableId,
  name: text,
  type: ordinal,
  smartQuery: nullableText,
  shared: boolean,
} as const;

export class FoldersStream extends AppleNotesStream<typeof properties, Row> {
  readonly name = 'folders';
  readonly jsonSchema = notesSchema(properties);

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
