import type { SchemaRecord } from 'elt';
import {
  AppleNotesStream,
  notesFields,
  notesSchema,
} from './apple-notes-stream.ts';
import type { NotesScan, Row } from './notes-scan.ts';

const { id, text, ordinal } = notesFields;

const properties = {
  id: {
    ...id,
    description:
      'Notes account identifier; referenced by the accountId fields of other streams from this source.',
  },
  name: { ...text, description: 'Account name displayed by Notes.' },
  type: {
    ...ordinal,
    description:
      'Numeric account type stored by Notes; an opaque category, not a quantity.',
  },
} as const;

export class AccountsStream extends AppleNotesStream<typeof properties, Row> {
  readonly name = 'accounts';
  readonly jsonSchema = notesSchema(
    properties,
    'One source record per account in the local Notes store, excluding accounts marked for deletion. This is what Notes has synced to this Mac.',
  );

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
