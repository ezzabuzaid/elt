import {
  type AddressBookStore,
  type ContactPartRow,
  dateComponentsView,
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
    ...attributeFields(dateComponentsView),
  },
  {
    id: "The date-components record's row in its store, AddressBook ZABCDDATECOMPONENTS.Z_PK; with store, the primary key.",
    contactId:
      'Owning contact: ZABCDDATECOMPONENTS.ZCONTACT, the Z_PK of that record. Refers to contacts.id in the same store.',
    uniqueId:
      'Native identifier of this date-components record, AddressBook ZABCDDATECOMPONENTS.ZUNIQUEID, as stored; no other stream refers to it.',
    calendarIdentifier:
      'Calendar identifier as stored in AddressBook ZABCDDATECOMPONENTS.ZCALENDARIDENTIFIER; names the calendar that era, year, month and day are counted in.',
    era: 'Era component as stored in AddressBook ZABCDDATECOMPONENTS.ZERA, in the calendar named by calendarIdentifier; NULL when the store holds no value.',
    year: 'Year component as stored in AddressBook ZABCDDATECOMPONENTS.ZYEAR, in the calendar named by calendarIdentifier and not converted; not comparable with contacts.birthdayYear. NULL when the store holds no value.',
    month:
      'Month component as stored in AddressBook ZABCDDATECOMPONENTS.ZMONTH, in the calendar named by calendarIdentifier; NULL when the store holds no value.',
    day: 'Day component as stored in AddressBook ZABCDDATECOMPONENTS.ZDAY, in the calendar named by calendarIdentifier; NULL when the store holds no value.',
  },
);

// The non-Gregorian birthday (CNContact.nonGregorianBirthday).
export class AlternateBirthdaysStream extends AppleContactsStream<ContactPartRow> {
  readonly name = 'alternateBirthdays';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per non-Gregorian birthday of a contact (CNContact.nonGregorianBirthday, which a live store saves here), as date components in the AddressBook table ZABCDDATECOMPONENTS. Primary key (store, id); contactId refers to contacts.id in the same store. The store does not stop a contact having two such records, and each loads. Components stay in the calendar named by calendarIdentifier and are not converted, so they do not compare with the contact's Gregorian birthdayYear, birthdayMonth and birthdayDay. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<ContactPartRow> {
    return store.alternateBirthdays();
  }

  protected accepts(row: ContactPartRow, selection: ContactSelection): boolean {
    return selection.contact(row.contactId);
  }

  protected records(row: ContactPartRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        contactId: row.contactId,
        ...attributeRecord(dateComponentsView, row.values),
      },
    ];
  }
}
