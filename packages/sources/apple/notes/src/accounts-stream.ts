import type { RecordDraft } from '@workspace/elt';
import type { NoteAccount } from '@workspace/sdk-apple-notes';

import { AppleNotesStream, notesFields } from './apple-notes-stream.ts';
import type { NotesScan } from './notes-scan.ts';

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

export class AccountsStream extends AppleNotesStream<
  typeof properties,
  NoteAccount
> {
  readonly name = 'accounts';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One source record per account in the local Notes store, excluding accounts marked for deletion. This is what Notes has synced to this Mac.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: NotesScan): readonly NoteAccount[] {
    return scan.accounts;
  }

  protected record(account: NoteAccount): RecordDraft<typeof properties> {
    return { id: account.id, name: account.name, type: account.type };
  }
}
