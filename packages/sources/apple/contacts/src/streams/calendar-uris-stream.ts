import {
  type AddressBookStore,
  type ValueRow,
  calendarUriView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(calendarUriView);

export class CalendarUrisStream extends LabeledValueStream {
  readonly name = 'calendarUris';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per calendar URI of a contact, a labeled value in the AddressBook table ZABCDCALENDARURI. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = calendarUriView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.calendarUris();
  }
}
