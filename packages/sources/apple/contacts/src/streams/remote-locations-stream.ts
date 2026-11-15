import {
  type AddressBookStore,
  type ValueRow,
  remoteLocationView,
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

const naming = { renames: { owner: 'recordId' } };

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    uniqueId: eventKitFields.nullableText,
    ...attributeFields(remoteLocationView, naming),
  },
  {
    id: "The remote location's row in its store, AddressBook ZABCDREMOTELOCATION.Z_PK; with store, the primary key.",
    uniqueId:
      'Remote location identifier, AddressBook ZABCDREMOTELOCATION.ZUNIQUEID, as stored; the store does not enforce it unique.',
    recordId:
      'Owning record: ZABCDREMOTELOCATION.ZOWNER, the Z_PK of that record. Join to contacts.id, groups.id or containers.id in the same store; it can name a record kind this source does not export. NULL when unset or no record matches.',
  },
);

export class RemoteLocationsStream extends AppleContactsStream<ValueRow> {
  readonly name = 'remoteLocations';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per remote location record in the AddressBook table ZABCDREMOTELOCATION, on any record. Primary key (store, id). recordId refers to contacts.id, groups.id or containers.id in the same store, or to a record kind this source does not export. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<ValueRow> {
    return store.remoteLocations();
  }

  protected accepts(row: ValueRow, selection: ContactSelection): boolean {
    return selection.record(row.values.owner);
  }

  protected records(row: ValueRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        uniqueId: row.uniqueId,
        ...attributeRecord(remoteLocationView, row.values, naming),
      },
    ];
  }
}
