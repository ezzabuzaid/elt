import type {
  AddressBookStore,
  GroupMemberRow,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { explained, localStores } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    groupId: eventKitFields.id,
    contactId: eventKitFields.id,
  },
  {
    groupId:
      'Group identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_19PARENTGROUPS1); refers to groups.id within this source.',
    contactId:
      'Member contact identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_22CONTACTS); refers to contacts.id within this source. A contact can belong to many groups.',
  },
);

export class GroupMembersStream extends AppleContactsStream<GroupMemberRow> {
  readonly name = 'groupMembers';
  readonly primaryKey = ['groupId', 'contactId'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per group membership stored in the AddressBook table Z_22PARENTGROUPS. Primary key (groupId, contactId). Only stored memberships appear; the connector does not evaluate smart group criteria. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly GroupMemberRow[] {
    return store.groupMembers();
  }

  protected accepts(row: GroupMemberRow, selection: ContactSelection): boolean {
    return selection.group(row.groupId) && selection.contact(row.contactId);
  }

  protected records(row: GroupMemberRow): Record<string, unknown>[] {
    return [{ groupId: row.groupId, contactId: row.contactId }];
  }
}
