import {
  type AddressBookStore,
  type ValueRow,
  customPropertyValueView,
  customPropertyView,
} from '@eltjs/sdk-apple-contacts';
import { eventKitFields } from '@eltjs/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  explained,
  localStores,
  storeField,
  unverified,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const naming = { renames: { owner: 'recordId' } };

const properties = explained(
  {
    store: storeField,
    id: eventKitFields.integer,
    uniqueId: eventKitFields.nullableText,
    ...attributeFields(customPropertyView),
    ...attributeFields(customPropertyValueView, naming),
  },
  {
    id: "The value's row in its store, AddressBook ZABCDCUSTOMPROPERTYVALUE.Z_PK; with store, the primary key.",
    uniqueId:
      'Custom property value identifier, AddressBook ZABCDCUSTOMPROPERTYVALUE.ZUNIQUEID, as stored; the store does not enforce it unique.',
    propertyName: `Property name as stored in AddressBook ZABCDCUSTOMPROPERTY.ZPROPERTYNAME, the definition ZABCDCUSTOMPROPERTYVALUE.ZCUSTOMPROPERTY references; NULL when the store holds no value or no definition record matches. ${unverified}`,
    recordType: `AddressBook ZABCDCUSTOMPROPERTY.ZRECORDTYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
    valueType: `AddressBook ZABCDCUSTOMPROPERTY.ZVALUETYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
    recordId:
      'Owning record: ZABCDCUSTOMPROPERTYVALUE.ZOWNER, the Z_PK of that record. Join to contacts.id, groups.id or containers.id in the same store; it can name a record kind this source does not export. NULL when unset or no record matches.',
  },
);

// Values of custom properties, on any record, with their property's definition.
export class CustomPropertyValuesStream extends AppleContactsStream<ValueRow> {
  readonly name = 'customPropertyValues';
  readonly primaryKey = ['store', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per custom property value in the AddressBook table ZABCDCUSTOMPROPERTYVALUE, on any record, with its property definition from ZABCDCUSTOMPROPERTY. Primary key (store, id). recordId refers to contacts.id, groups.id or containers.id in the same store, or to a record kind this source does not export. propertyName, recordType and valueType are NULL when the value has no definition record. Which of stringValue, numberValue, dateValue and dataValue holds the value is not verified against valueType. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): Iterable<ValueRow> {
    return store.customPropertyValues();
  }

  protected accepts(row: ValueRow, selection: ContactSelection): boolean {
    return selection.record(row.values.owner);
  }

  protected records(row: ValueRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        uniqueId: row.uniqueId,
        ...attributeRecord(customPropertyView, row.values),
        ...attributeRecord(customPropertyValueView, row.values, naming),
      },
    ];
  }
}
