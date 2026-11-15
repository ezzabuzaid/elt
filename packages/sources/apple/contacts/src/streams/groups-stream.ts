import {
  type AddressBookStore,
  type GroupEntity,
  type RecordRow,
  groupView,
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
  ABCDGroup: 'group',
  ABCDSubscribedGroup: 'subscribedGroup',
  ABCDSmartGroup: 'smartGroup',
} as const satisfies Record<GroupEntity, string>;

const naming = { renames: { container: 'containerId' } };

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    uniqueId: eventKitFields.nullableText,
    kind: entityKind(kinds),
    ...attributeFields(groupView, naming),
    ...attributeFields(recordView),
  },
  {
    id: "The group's row in its store, AddressBook ZABCDRECORD.Z_PK; with store, the primary key. groupMembers.groupId, groupSubgroups.parentGroupId, groupSubgroups.childGroupId and distributionListConfigs.groupId refer to it within the same store.",
    uniqueId:
      'Group identifier, AddressBook ZABCDRECORD.ZUNIQUEID: the Contacts.framework identifier (CNGroup.identifier, …:ABGroup). The store indexes it but does not enforce it unique.',
    containerId:
      'Owning container: AddressBook ZABCDRECORD.ZCONTAINER, the Z_PK of that record. Join to containers.id in the same store. NULL when unset or no record matches.',
  },
);

export class GroupsStream extends AppleContactsStream<RecordRow<GroupEntity>> {
  readonly name = 'groups';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per group record: an ABCDGroup, ABCDSubscribedGroup or ABCDSmartGroup, told apart by kind. Primary key (store, id); containerId refers to containers.id in the same store. Stored members are in groupMembers, stored nesting in groupSubgroups and per-member address choices in distributionListConfigs. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<RecordRow<GroupEntity>> {
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
        uniqueId: row.uniqueId,
        kind: row.entity === null ? null : kinds[row.entity],
        ...attributeRecord(groupView, row.values, naming),
        ...attributeRecord(recordView, row.values),
      },
    ];
  }
}
