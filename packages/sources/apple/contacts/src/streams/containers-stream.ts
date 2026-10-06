import {
  type AddressBookStore,
  type ContainerEntity,
  type RecordRow,
  containerView,
  recordView,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  explained,
  localStores,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const naming = { renames: { me: 'meContactId' } };

const properties = explained(
  {
    id: eventKitFields.id,
    source: eventKitFields.nullableText,
    ...attributeFields(containerView, naming),
    ...attributeFields(recordView),
  },
  {
    id: 'Container identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key.',
    source:
      'Directory name under AddressBook/Sources of the account store this container was read from; NULL for the On My Mac store at the AddressBook root.',
    meContactId:
      "AddressBook ZABCDRECORD.ZME resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches.",
  },
);

export class ContainersStream extends AppleContactsStream<
  RecordRow<ContainerEntity>
> {
  readonly name = 'containers';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per Contacts container, a CNCDContainer record in a store. Primary key id. contacts.containerId, contacts.meOfContainerId and groups.containerId refer to id. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(
    store: AddressBookStore,
  ): readonly RecordRow<ContainerEntity>[] {
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
        source: store.source,
        ...attributeRecord(containerView, row.values, naming),
        ...attributeRecord(recordView, row.values),
      },
    ];
  }
}
