import {
  type AddressBookStore,
  type ValueRow,
  alertToneView,
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

const naming = { renames: { owner: 'contactId' } };

const properties = explained(
  {
    id: eventKitFields.id,
    ...attributeFields(alertToneView, naming),
  },
  {
    id: 'Alert tone identifier, AddressBook ZABCDALERTTONE.ZUNIQUEID; the primary key.',
    contactId:
      "Owning contact: ZABCDALERTTONE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches.",
  },
);

export class AlertTonesStream extends AppleContactsStream<ValueRow> {
  readonly name = 'alertTones';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per alert tone record of a contact in the AddressBook table ZABCDALERTTONE. Primary key id; contactId refers to contacts.id, and a contact can have several. type and toneData are exported as stored and their values are not documented by Apple. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.alertTones();
  }

  protected accepts(row: ValueRow, selection: ContactSelection): boolean {
    return selection.contact(row.values.owner);
  }

  protected records(row: ValueRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        ...attributeRecord(alertToneView, row.values, naming),
      },
    ];
  }
}
