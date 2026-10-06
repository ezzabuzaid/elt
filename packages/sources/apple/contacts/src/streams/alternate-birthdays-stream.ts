import {
  type AddressBookStore,
  type ContactPartRow,
  dateComponentsView,
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
  { contactId: eventKitFields.id, ...attributeFields(dateComponentsView) },
  {
    contactId:
      'Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDATECOMPONENTS.ZCONTACT); the primary key. Refers to contacts.id within this source.',
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
  readonly primaryKey = ['contactId'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per contact with a non-Gregorian birthday (CNContact.nonGregorianBirthday, which a live store saves here), as date components in the AddressBook table ZABCDDATECOMPONENTS. Primary key contactId, which refers to contacts.id; one record per contact is assumed, since the store does not enforce it. Components stay in the calendar named by calendarIdentifier and are not converted, so they do not compare with the contact's Gregorian birthdayYear, birthdayMonth and birthdayDay. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly ContactPartRow[] {
    return store.alternateBirthdays();
  }

  protected accepts(row: ContactPartRow, selection: ContactSelection): boolean {
    return selection.contact(row.contactId);
  }

  protected records(row: ContactPartRow): Record<string, unknown>[] {
    return [
      {
        contactId: row.contactId,
        ...attributeRecord(dateComponentsView, row.values),
      },
    ];
  }
}
