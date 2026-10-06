import {
  type AddressBookStore,
  type ValueRow,
  contactDateView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const naming = { dates: { date: ['year', 'month', 'day'] } } as const;

const properties = labeledFields(contactDateView, naming);

export class ContactDatesStream extends LabeledValueStream {
  readonly name = 'contactDates';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per labeled date of a contact in the AddressBook table ZABCDCONTACTDATE, split into Gregorian year, month and day; year is NULL for a date stored without a year. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = contactDateView;
  protected override readonly naming = naming;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.contactDates();
  }
}
