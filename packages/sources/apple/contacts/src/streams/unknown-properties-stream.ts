import type {
  AddressBookStore,
  UnknownPropertyRow,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { encode, explained, localStores } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    id: eventKitFields.integer,
    recordId: eventKitFields.id,
    propertyName: eventKitFields.text,
    originalLine: eventKitFields.text,
  },
  {
    id: "The line's row number in its store (ZABCDUNKNOWNPROPERTY.Z_PK); with recordId, the primary key. It is unique only within one store, and recordId names the store.",
    recordId:
      'Owning record identifier (ZABCDRECORD.ZUNIQUEID of ZABCDUNKNOWNPROPERTY.ZOWNER); with id, the primary key. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export.',
    propertyName:
      'vCard property name as stored in AddressBook ZABCDUNKNOWNPROPERTY.ZPROPERTYNAME.',
    originalLine:
      'The original vCard line from AddressBook ZABCDUNKNOWNPROPERTY.ZORIGINALLINE, which stores bytes: exported as Base64 of those bytes, so decoding it recovers the exact line, unless those bytes form a binary property list, which loads as JSON instead. Text the store holds as text passes through unchanged.',
  },
);

// vCard lines Contacts kept without understanding them, one record per row.
export class UnknownPropertiesStream extends AppleContactsStream<UnknownPropertyRow> {
  readonly name = 'unknownProperties';
  readonly primaryKey = ['recordId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per row of the AddressBook table ZABCDUNKNOWNPROPERTY: a vCard line that Contacts kept without interpreting it. The primary key is (recordId, id): id is the row's Z_PK, unique within its store, and recordId names the store. The same line stored twice on one record is two rows. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. ${localStores}`,
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
