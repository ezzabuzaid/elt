import {
  type AddressBookStore,
  type ContactPartRow,
  noteView,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  explained,
  localStores,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  { contactId: eventKitFields.id, ...attributeFields(noteView) },
  {
    contactId:
      'Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDNOTE.ZCONTACT); the primary key. Refers to contacts.id within this source.',
  },
);

export class NotesStream extends AppleContactsStream<ContactPartRow> {
  readonly name = 'notes';
  readonly primaryKey = ['contactId'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per contact that has a note record in the AddressBook table ZABCDNOTE. Primary key contactId, which refers to contacts.id; one note per contact is assumed, since the store does not enforce it. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly ContactPartRow[] {
    return store.notes();
  }

  protected accepts(row: ContactPartRow, selection: ContactSelection): boolean {
    return selection.contact(row.contactId);
  }

  protected records(row: ContactPartRow): Record<string, unknown>[] {
    return [
      { contactId: row.contactId, ...attributeRecord(noteView, row.values) },
    ];
  }
}
