import {
  type AddressBookStore,
  type GroupEntity,
  type RecordRow,
  groupView,
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
  ABCDGroup: 'group',
  ABCDSubscribedGroup: 'subscribedGroup',
  ABCDSmartGroup: 'smartGroup',
} as const satisfies Record<GroupEntity, string>;

const naming = { renames: { container: 'containerId' } };

const properties = explained(
  {
    id: eventKitFields.id,
    kind: entityKind(kinds),
    ...attributeFields(groupView, naming),
    ...attributeFields(recordView),
  },
  {
    id: 'Group identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. groupMembers.groupId, groupSubgroups.parentGroupId, groupSubgroups.childGroupId and distributionListConfigs.groupId refer to it.',
    containerId:
      "Owning container: AddressBook ZABCDRECORD.ZCONTAINER resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
  },
);

export class GroupsStream extends AppleContactsStream<RecordRow<GroupEntity>> {
  readonly name = 'groups';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per group record: an ABCDGroup, ABCDSubscribedGroup or ABCDSmartGroup, told apart by kind. Primary key id; containerId refers to containers.id. Stored members are in groupMembers, stored nesting in groupSubgroups and per-member address choices in distributionListConfigs. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly RecordRow<GroupEntity>[] {
    return store.groups();
  }

  protected accepts(
    row: RecordRow<GroupEntity>,
    selection: ContactSelection,
  ): boolean {
    return selection.group(row.id);
  }

  protected records(row: RecordRow<GroupEntity>): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        kind: row.entity === null ? null : kinds[row.entity],
        ...attributeRecord(groupView, row.values, naming),
        ...attributeRecord(recordView, row.values),
      },
    ];
  }
}
