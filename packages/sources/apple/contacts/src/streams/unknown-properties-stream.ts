import type {
  AddressBookStore,
  UnknownPropertyRow,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { encode, explained, localStores } from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const properties = explained(
  {
    recordId: eventKitFields.id,
    propertyName: eventKitFields.text,
    originalLine: eventKitFields.text,
  },
  {
    recordId:
      'Owning record identifier (ZABCDRECORD.ZUNIQUEID of ZABCDUNKNOWNPROPERTY.ZOWNER). Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export.',
    propertyName:
      'vCard property name as stored in AddressBook ZABCDUNKNOWNPROPERTY.ZPROPERTYNAME.',
    originalLine:
      'The original vCard line from AddressBook ZABCDUNKNOWNPROPERTY.ZORIGINALLINE, which stores bytes: exported as Base64 of those bytes, so decoding it recovers the exact line, unless those bytes form a binary property list, which loads as JSON instead. Text the store holds as text passes through unchanged.',
  },
);

// vCard lines Contacts kept without understanding them. They have no
// identifier, so the line itself is part of the key.
export class UnknownPropertiesStream extends AppleContactsStream<UnknownPropertyRow> {
  readonly name = 'unknownProperties';
  readonly primaryKey = ['recordId', 'propertyName', 'originalLine'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per distinct vCard line that Contacts kept without interpreting it, from the AddressBook table ZABCDUNKNOWNPROPERTY. The native rows have no identifier, so the primary key is (recordId, propertyName, originalLine); the same line stored twice on one record is one row. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly UnknownPropertyRow[] {
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
        recordId: row.recordId,
        propertyName: encode(row.propertyName),
        originalLine: encode(row.originalLine),
      },
    ];
  }
}
