import type {
  AddressBookStore,
  GroupSubgroupRow,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { explained, localStores } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    parentGroupId: eventKitFields.id,
    childGroupId: eventKitFields.id,
  },
  {
    parentGroupId:
      'Parent group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_19PARENTGROUPS); refers to groups.id within this source.',
    childGroupId:
      'Child group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_18CHILDGROUPS); refers to groups.id within this source.',
  },
);

export class GroupSubgroupsStream extends AppleContactsStream<GroupSubgroupRow> {
  readonly name = 'groupSubgroups';
  readonly primaryKey = ['parentGroupId', 'childGroupId'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per direct parent-child link between groups stored in the AddressBook table Z_18PARENTGROUPS. Primary key (parentGroupId, childGroupId), both groups.id within this source. Deeper nesting is a chain of rows; a child can have several parents. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly GroupSubgroupRow[] {
    return store.groupSubgroups();
  }

  protected accepts(
    row: GroupSubgroupRow,
    selection: ContactSelection,
  ): boolean {
    return (
      selection.group(row.parentGroupId) && selection.group(row.childGroupId)
    );
  }

  protected records(row: GroupSubgroupRow): Record<string, unknown>[] {
    return [
      { parentGroupId: row.parentGroupId, childGroupId: row.childGroupId },
    ];
  }
}
