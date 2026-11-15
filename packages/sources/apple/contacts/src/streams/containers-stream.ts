import {
  type AddressBookStore,
  type ContainerEntity,
  type RecordRow,
  containerView,
  recordView,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  explained,
  localStores,
  storeField,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const naming = { renames: { me: 'meContactId' } };

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    uniqueId: eventKitFields.nullableText,
    source: eventKitFields.nullableText,
    ...attributeFields(containerView, naming),
    ...attributeFields(recordView),
  },
  {
    id: "The container's row in its store, AddressBook ZABCDRECORD.Z_PK; with store, the primary key.",
    uniqueId:
      'Container identifier, AddressBook ZABCDRECORD.ZUNIQUEID, which a container selection names. The store indexes it but does not enforce it unique.',
    source:
      'Directory name under AddressBook/Sources of the account store this container was read from; NULL for the On My Mac store at the AddressBook root.',
    meContactId:
      'AddressBook ZABCDRECORD.ZME, the Z_PK of that record. Join to contacts.id in the same store. NULL when unset or no record matches.',
  },
);

export class ContainersStream extends AppleContactsStream<
  RecordRow<ContainerEntity>
> {
  readonly name = 'containers';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per Contacts container, a CNCDContainer record in a store. Primary key (store, id). contacts.containerId, contacts.meOfContainerId and groups.containerId refer to id in the same store. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(
    store: AddressBookStore,
  ): Iterable<RecordRow<ContainerEntity>> {
    return store.containers();
  }

  protected accepts(
    row: RecordRow<ContainerEntity>,
    selection: ContactSelection,
  ): boolean {
    return selection.container(row.id);
  }

  protected records(
    row: RecordRow<ContainerEntity>,
    store: AddressBookStore,
  ): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        uniqueId: row.uniqueId,
        source: store.source,
        ...attributeRecord(containerView, row.values, naming),
        ...attributeRecord(recordView, row.values),
      },
    ];
  }
}
