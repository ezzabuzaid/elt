import type {
  AddressBookStore,
  GroupSubgroupRow,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { explained, localStores, storeField } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    store: storeField,
    parentGroupId: eventKitFields.integer,
    childGroupId: eventKitFields.integer,
  },
  {
    parentGroupId:
      'Parent group: Z_18PARENTGROUPS.Z_19PARENTGROUPS, the Z_PK of that record; refers to groups.id in the same store.',
    childGroupId:
      'Child group: Z_18PARENTGROUPS.Z_18CHILDGROUPS, the Z_PK of that record; refers to groups.id in the same store.',
  },
);

export class GroupSubgroupsStream extends AppleContactsStream<GroupSubgroupRow> {
  readonly name = 'groupSubgroups';
  readonly primaryKey = ['store', 'parentGroupId', 'childGroupId'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per direct parent-child link between groups stored in the AddressBook table Z_18PARENTGROUPS. Primary key (store, parentGroupId, childGroupId): the table's own PRIMARY KEY, within its store; both are groups.id in the same store. Deeper nesting is a chain of rows; a child can have several parents. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<GroupSubgroupRow> {
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
