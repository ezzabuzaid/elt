import type {
  AddressBookStore,
  GroupMemberRow,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { explained, localStores, storeField } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    store: storeField,
    groupId: eventKitFields.integer,
    contactId: eventKitFields.integer,
  },
  {
    groupId:
      'Group: Z_22PARENTGROUPS.Z_19PARENTGROUPS1, the Z_PK of that record; refers to groups.id in the same store.',
    contactId:
      'Member contact: Z_22PARENTGROUPS.Z_22CONTACTS, the Z_PK of that record; refers to contacts.id in the same store. A contact can belong to many groups.',
  },
);

export class GroupMembersStream extends AppleContactsStream<GroupMemberRow> {
  readonly name = 'groupMembers';
  readonly primaryKey = ['store', 'groupId', 'contactId'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per group membership stored in the AddressBook table Z_22PARENTGROUPS. Primary key (store, groupId, contactId): the table's own PRIMARY KEY, within its store. Only stored memberships appear; the connector does not evaluate smart group criteria. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<GroupMemberRow> {
    return store.groupMembers();
  }

  protected accepts(row: GroupMemberRow, selection: ContactSelection): boolean {
    return selection.group(row.groupId) && selection.contact(row.contactId);
  }

  protected records(row: GroupMemberRow): Record<string, unknown>[] {
    return [{ groupId: row.groupId, contactId: row.contactId }];
  }
}
