import {
  type AddressBookStore,
  type ValueRow,
  alertToneView,
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

const naming = { renames: { owner: 'contactId' } };

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    uniqueId: eventKitFields.nullableText,
    ...attributeFields(alertToneView, naming),
  },
  {
    id: "The alert tone's row in its store, AddressBook ZABCDALERTTONE.Z_PK; with store, the primary key.",
    uniqueId:
      'Alert tone identifier, AddressBook ZABCDALERTTONE.ZUNIQUEID, as stored; the store does not enforce it unique.',
    contactId:
      'Owning contact: ZABCDALERTTONE.ZOWNER, the Z_PK of that record. Join to contacts.id in the same store. NULL when unset or no record matches.',
  },
);

export class AlertTonesStream extends AppleContactsStream<ValueRow> {
  readonly name = 'alertTones';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per alert tone record of a contact in the AddressBook table ZABCDALERTTONE. Primary key (store, id); contactId refers to contacts.id in the same store, and a contact can have several. type and toneData are exported as stored and their values are not documented by Apple. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<ValueRow> {
    return store.alertTones();
  }

  protected accepts(row: ValueRow, selection: ContactSelection): boolean {
    return selection.contact(row.values.owner);
  }

  protected records(row: ValueRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        uniqueId: row.uniqueId,
        ...attributeRecord(alertToneView, row.values, naming),
      },
    ];
  }
}
