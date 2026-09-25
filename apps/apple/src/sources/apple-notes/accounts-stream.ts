import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import type { NotesScan, Row } from './notes-scan.ts';

const { id, text, ordinal } = notesFields;

const properties = { id, name: text, type: ordinal } as const;

export class AccountsStream extends AppleNotesStream<typeof properties, Row> {
  readonly name = 'accounts';
  readonly jsonSchema = notesSchema(properties);

  protected rows(scan: NotesScan): readonly Row[] {
    return scan.accounts;
  }

  protected record(row: Row): SchemaRecord<typeof properties> {
    return {
      id: row.ZIDENTIFIER as string,
      name: row.ZNAME as string,
      type: row.ZACCOUNTTYPE as number,
    };
  }
}
