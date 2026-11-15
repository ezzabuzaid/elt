import {
  type AddressBookStore,
  type ContactEntity,
  type RecordRow,
  contactView,
  recordView,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  entityKind,
  explained,
  localStores,
  storeField,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const kinds = {
  ABCDContact: 'contact',
  ABCDSubscribedContact: 'subscribedContact',
} as const satisfies Record<ContactEntity, string>;

const naming = {
  renames: {
    container: 'containerId',
    containerWhereContactIsMe: 'meOfContainerId',
  },
  dates: { birthday: ['birthdayYear', 'birthdayMonth', 'birthdayDay'] },
} as const;

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    uniqueId: eventKitFields.nullableText,
    kind: entityKind(kinds),
    ...attributeFields(contactView, naming),
    ...attributeFields(recordView),
  },
  {
    id: "The contact's row in its store, AddressBook ZABCDRECORD.Z_PK; with store, the primary key. contactId fields in other streams of this source refer to it within the same store.",
    uniqueId:
      'Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID: the Contacts.framework identifier (CNContact.identifier, …:ABPerson), which other apps such as WhatsApp keep. The store indexes it but does not enforce it unique.',
    containerId:
      'Owning container: AddressBook ZABCDRECORD.ZCONTAINER1, the Z_PK of that record. Join to containers.id in the same store. NULL when unset or no record matches.',
    meOfContainerId:
      'AddressBook ZABCDRECORD.ZCONTAINERWHERECONTACTISME, the Z_PK of that record. Join to containers.id in the same store. NULL when unset or no record matches.',
  },
);

export class ContactsStream extends AppleContactsStream<
  RecordRow<ContactEntity>
> {
  readonly name = 'contacts';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per contact record: an ABCDContact or ABCDSubscribedContact, told apart by kind. Primary key (store, id); containerId refers to containers.id in the same store. Multi-valued details are separate streams keyed by their own (store, id) with contactId: phoneNumbers, emailAddresses, postalAddresses, urlAddresses, socialProfiles, messagingAddresses, relatedNames, contactDates, calendarUris, addressingGrammars and likenesses; alertTones, notes, alternateBirthdays and images also carry contactId, and groupMembers lists stored group membership. The same person in two stores is two rows; this source does not merge them. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<RecordRow<ContactEntity>> {
    return store.contacts();
  }

  protected accepts(
    row: RecordRow<ContactEntity>,
    selection: ContactSelection,
  ): boolean {
    return selection.contact(row.id);
  }

  protected records(row: RecordRow<ContactEntity>): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        uniqueId: row.uniqueId,
        kind: row.entity === null ? null : kinds[row.entity],
        ...attributeRecord(contactView, row.values, naming),
        ...attributeRecord(recordView, row.values),
      },
    ];
  }
}
