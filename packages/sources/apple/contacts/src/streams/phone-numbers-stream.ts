import {
  type AddressBookStore,
  type ValueRow,
  phoneNumberView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(phoneNumberView);

export class PhoneNumbersStream extends LabeledValueStream {
  readonly name = 'phoneNumbers';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per phone number of a contact, a labeled value in the AddressBook table ZABCDPHONENUMBER. ${labeledValue} distributionListConfigs.phoneId refers to id. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = phoneNumberView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.phoneNumbers();
  }
}
