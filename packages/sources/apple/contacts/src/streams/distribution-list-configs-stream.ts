import type {
  AddressBookStore,
  DistributionListConfigRow,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  encode,
  explained,
  localStores,
  nullableInteger,
  storeField,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const { integer, text } = eventKitFields;

const properties = explained(
  {
    store: storeField,
    id: integer,
    groupId: integer,
    contactId: integer,
    propertyName: text,
    emailId: nullableInteger,
    phoneId: nullableInteger,
    addressId: nullableInteger,
  },
  {
    id: "The choice's row in its store, AddressBook ZABCDDISTRIBUTIONLISTCONFIG.Z_PK; with store, the primary key.",
    groupId:
      'Group: ZABCDDISTRIBUTIONLISTCONFIG.ZGROUP, the Z_PK of that record; refers to groups.id in the same store.',
    contactId:
      'Member contact: ZABCDDISTRIBUTIONLISTCONFIG.ZCONTACT, the Z_PK of that record; refers to contacts.id in the same store.',
    propertyName:
      'The contact property the choice is for, as stored in AddressBook ZABCDDISTRIBUTIONLISTCONFIG.ZPROPERTYNAME (Email for an email address choice, as a live store shows). Other values are not verified.',
    emailId:
      'Chosen email address: ZABCDDISTRIBUTIONLISTCONFIG.ZEMAIL, the Z_PK of that ZABCDEMAILADDRESS record. Join to emailAddresses.id in the same store. NULL when unset or no record matches.',
    phoneId:
      'Chosen phone number: ZABCDDISTRIBUTIONLISTCONFIG.ZPHONE, the Z_PK of that ZABCDPHONENUMBER record. Join to phoneNumbers.id in the same store. NULL when unset or no record matches.',
    addressId:
      'Chosen postal address: ZABCDDISTRIBUTIONLISTCONFIG.ZADDRESS, the Z_PK of that ZABCDPOSTALADDRESS record. Join to postalAddresses.id in the same store. NULL when unset or no record matches.',
  },
);

// The address a distribution list (group) uses for each member.
export class DistributionListConfigsStream extends AppleContactsStream<DistributionListConfigRow> {
  readonly name = 'distributionListConfigs';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per distribution-list choice in the AddressBook table ZABCDDISTRIBUTIONLISTCONFIG: which of member contactId's email addresses, phone numbers or postal addresses group groupId uses for that member, as set by Contacts' Edit Distribution List (ABGroup setDistributionIdentifier:forProperty:person:, which a live store saves here). A member without a row uses its default value. Primary key (store, id). The store does not stop two rows for one group, member and property, and each loads. emailId, phoneId and addressId refer to emailAddresses.id, phoneNumbers.id and postalAddresses.id in the same store. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<DistributionListConfigRow> {
    return store.distributionListConfigs();
  }

  protected accepts(
    row: DistributionListConfigRow,
    selection: ContactSelection,
  ): boolean {
    return selection.group(row.groupId) && selection.contact(row.contactId);
  }

  protected records(row: DistributionListConfigRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        groupId: row.groupId,
        contactId: row.contactId,
        propertyName: encode(row.propertyName),
        emailId: row.emailId,
        phoneId: row.phoneId,
        addressId: row.addressId,
      },
    ];
  }
}
