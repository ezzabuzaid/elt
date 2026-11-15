import type {
  AddressBookStore,
  UnknownPropertyRow,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  encode,
  explained,
  localStores,
  storeField,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    recordId: eventKitFields.integer,
    propertyName: eventKitFields.text,
    originalLine: eventKitFields.text,
  },
  {
    id: "The line's row in its store, AddressBook ZABCDUNKNOWNPROPERTY.Z_PK; with store, the primary key.",
    recordId:
      'Owning record: ZABCDUNKNOWNPROPERTY.ZOWNER, the Z_PK of that record. Join to contacts.id, groups.id or containers.id in the same store; it can name a record kind this source does not export.',
    propertyName:
      'vCard property name as stored in AddressBook ZABCDUNKNOWNPROPERTY.ZPROPERTYNAME.',
    originalLine:
      'The original vCard line from AddressBook ZABCDUNKNOWNPROPERTY.ZORIGINALLINE, which stores bytes: exported as Base64 of those bytes, so decoding it recovers the exact line, unless those bytes form a binary property list, which loads as JSON instead. Text the store holds as text passes through unchanged.',
  },
);

// vCard lines Contacts kept without understanding them, one record per row.
export class UnknownPropertiesStream extends AppleContactsStream<UnknownPropertyRow> {
  readonly name = 'unknownProperties';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per row of the AddressBook table ZABCDUNKNOWNPROPERTY: a vCard line that Contacts kept without interpreting it. Primary key (store, id). The same line stored twice on one record is two rows. recordId refers to contacts.id, groups.id or containers.id in the same store, or to a record kind this source does not export. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<UnknownPropertyRow> {
    return store.unknownProperties();
  }

  protected accepts(
    row: UnknownPropertyRow,
    selection: ContactSelection,
  ): boolean {
    return selection.record(row.recordId);
  }

  protected records(row: UnknownPropertyRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        recordId: row.recordId,
        propertyName: encode(row.propertyName),
        originalLine: encode(row.originalLine),
      },
    ];
  }
}
