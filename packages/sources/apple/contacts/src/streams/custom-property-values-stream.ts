import {
  type AddressBookStore,
  type ValueRow,
  customPropertyValueView,
  customPropertyView,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import {
  attributeFields,
  attributeRecord,
  explained,
  localStores,
  unverified,
} from '../contacts-fields.ts';
import type { ContactSelection } from '../contacts-scan.ts';

const naming = { renames: { owner: 'recordId' } };

const properties = explained(
  {
    id: eventKitFields.id,
    ...attributeFields(customPropertyView),
    ...attributeFields(customPropertyValueView, naming),
  },
  {
    id: 'Custom property value identifier, AddressBook ZABCDCUSTOMPROPERTYVALUE.ZUNIQUEID; the primary key.',
    propertyName: `Property name as stored in AddressBook ZABCDCUSTOMPROPERTY.ZPROPERTYNAME, the definition ZABCDCUSTOMPROPERTYVALUE.ZCUSTOMPROPERTY references; NULL when the store holds no value or no definition record matches. ${unverified}`,
    recordType: `AddressBook ZABCDCUSTOMPROPERTY.ZRECORDTYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
    valueType: `AddressBook ZABCDCUSTOMPROPERTY.ZVALUETYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
    recordId:
      "Owning record: ZABCDCUSTOMPROPERTYVALUE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches.",
  },
);

// Values of custom properties, on any record, with their property's definition.
export class CustomPropertyValuesStream extends AppleContactsStream<ValueRow> {
  readonly name = 'customPropertyValues';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description: `One row per custom property value in the AddressBook table ZABCDCUSTOMPROPERTYVALUE, on any record, with its property definition from ZABCDCUSTOMPROPERTY. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. propertyName, recordType and valueType are NULL when the value has no definition record. Which of stringValue, numberValue, dateValue and dataValue holds the value is not verified against valueType. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.customPropertyValues();
  }

  protected accepts(row: ValueRow, selection: ContactSelection): boolean {
    return selection.record(row.values.owner);
  }

  protected records(row: ValueRow): Record<string, unknown>[] {
    return [
      {
        id: row.id,
        ...attributeRecord(customPropertyView, row.values),
        ...attributeRecord(customPropertyValueView, row.values, naming),
      },
    ];
  }
}
