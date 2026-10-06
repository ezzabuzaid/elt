import {
  type AddressBookStore,
  type ContactEntity,
  type RecordRow,
  contactView,
  recordView,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  entityKind,
  explained,
  localStores,
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
    id: eventKitFields.id,
    kind: entityKind(kinds),
    ...attributeFields(contactView, naming),
    ...attributeFields(recordView),
  },
  {
    id: 'Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. contactId fields in other streams of this source refer to it.',
    containerId:
      "Owning container: AddressBook ZABCDRECORD.ZCONTAINER1 resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
    meOfContainerId:
      "AddressBook ZABCDRECORD.ZCONTAINERWHERECONTACTISME resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
  },
);

export class ContactsStream extends AppleContactsStream<
  RecordRow<ContactEntity>
> {
  readonly name = 'contacts';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per contact record: an ABCDContact or ABCDSubscribedContact, told apart by kind. Primary key id; containerId refers to containers.id. Multi-valued details are separate streams keyed by their own id with contactId: phoneNumbers, emailAddresses, postalAddresses, urlAddresses, socialProfiles, messagingAddresses, relatedNames, contactDates, calendarUris, addressingGrammars and likenesses; alertTones, notes, alternateBirthdays and images also carry contactId, and groupMembers lists stored group membership. The same person in two stores is two rows; this source does not merge them. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly RecordRow<ContactEntity>[] {
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
        kind: row.entity === null ? null : kinds[row.entity],
        ...attributeRecord(contactView, row.values, naming),
        ...attributeRecord(recordView, row.values),
      },
    ];
  }
}
