import {
  type AddressBookStore,
  type ValueRow,
  remoteLocationView,
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

const naming = { renames: { owner: 'recordId' } };

const properties = explained(
  {
    id: eventKitFields.id,
    ...attributeFields(remoteLocationView, naming),
  },
  {
    id: 'Remote location identifier, AddressBook ZABCDREMOTELOCATION.ZUNIQUEID; the primary key.',
    recordId:
      "Owning record: ZABCDREMOTELOCATION.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches.",
  },
);

export class RemoteLocationsStream extends AppleContactsStream<ValueRow> {
  readonly name = 'remoteLocations';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per remote location record in the AddressBook table ZABCDREMOTELOCATION, on any record. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.remoteLocations();
  }

  protected accepts(row: ValueRow, selection: ContactSelection): boolean {
    return selection.record(row.values.owner);
  }

  protected records(row: ValueRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        ...attributeRecord(remoteLocationView, row.values, naming),
      },
    ];
  }
}
