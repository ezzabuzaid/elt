import {
  type AddressBookStore,
  type ContactPartRow,
  noteView,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  explained,
  localStores,
  storeField,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    contactId: eventKitFields.integer,
    ...attributeFields(noteView),
  },
  {
    id: "The note's row in its store, AddressBook ZABCDNOTE.Z_PK; with store, the primary key.",
    contactId:
      'Owning contact: ZABCDNOTE.ZCONTACT, the Z_PK of that record. Refers to contacts.id in the same store.',
  },
);

export class NotesStream extends AppleContactsStream<ContactPartRow> {
  readonly name = 'notes';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per note record in the AddressBook table ZABCDNOTE. Primary key (store, id); contactId refers to contacts.id in the same store. The store does not stop a contact having two notes, and each loads. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<ContactPartRow> {
    return store.notes();
  }

  protected accepts(row: ContactPartRow, selection: ContactSelection): boolean {
    return selection.contact(row.contactId);
  }

  protected records(row: ContactPartRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        contactId: row.contactId,
        ...attributeRecord(noteView, row.values),
      },
    ];
  }
}
