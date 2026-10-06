import type {
  AddressBookStore,
  DistributionListConfigRow,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { encode, explained, localStores } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const { id, text, nullableText } = eventKitFields;

const properties = explained(
  {
    groupId: id,
    contactId: id,
    propertyName: text,
    emailId: nullableText,
    phoneId: nullableText,
    addressId: nullableText,
  },
  {
    groupId:
      'Group identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZGROUP); refers to groups.id within this source.',
    contactId:
      'Member contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZCONTACT); refers to contacts.id within this source.',
    propertyName:
      'The contact property the choice is for, as stored in AddressBook ZABCDDISTRIBUTIONLISTCONFIG.ZPROPERTYNAME (Email for an email address choice, as a live store shows); part of the key. Other values are not verified.',
    emailId:
      "Chosen email address: the record ZABCDDISTRIBUTIONLISTCONFIG.ZEMAIL references, resolved to that ZABCDEMAILADDRESS record's ZUNIQUEID. Join to emailAddresses.id within this source. NULL when unset or no record matches.",
    phoneId:
      "Chosen phone number: the record ZABCDDISTRIBUTIONLISTCONFIG.ZPHONE references, resolved to that ZABCDPHONENUMBER record's ZUNIQUEID. Join to phoneNumbers.id within this source. NULL when unset or no record matches.",
    addressId:
      "Chosen postal address: the record ZABCDDISTRIBUTIONLISTCONFIG.ZADDRESS references, resolved to that ZABCDPOSTALADDRESS record's ZUNIQUEID. Join to postalAddresses.id within this source. NULL when unset or no record matches.",
  },
);

// The address a distribution list (group) uses for each member.
export class DistributionListConfigsStream extends AppleContactsStream<DistributionListConfigRow> {
  readonly name = 'distributionListConfigs';
  readonly primaryKey = ['groupId', 'contactId', 'propertyName'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per distribution-list choice in the AddressBook table ZABCDDISTRIBUTIONLISTCONFIG: which of member contactId's email addresses, phone numbers or postal addresses group groupId uses for that member, as set by Contacts' Edit Distribution List (ABGroup setDistributionIdentifier:forProperty:person:, which a live store saves here). A member without a row uses its default value. Primary key (groupId, contactId, propertyName), assumed unique since the store does not enforce it. emailId, phoneId and addressId refer to emailAddresses.id, phoneNumbers.id and postalAddresses.id within this source. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(
    store: AddressBookStore,
  ): readonly DistributionListConfigRow[] {
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
