import type { SchemaRecord } from 'elt';
import { AppleNotesStream, notesSchema } from './apple-notes-stream.ts';

const properties = {
  id: { type: 'string' },
  name: { type: 'string' },
  upgraded: { type: 'boolean' },
} as const;

export type Account = SchemaRecord<typeof properties>;

export class AccountsStream extends AppleNotesStream<typeof properties> {
  readonly name = 'accounts';
  readonly jsonSchema = notesSchema(properties);

  protected readonly script = `
      app.accounts().map(account => ({
        id: account.id(),
        name: account.name(),
        upgraded: account.upgraded()
      }))
  `;
}
