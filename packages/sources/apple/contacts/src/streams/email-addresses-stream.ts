import {
  type AddressBookStore,
  type ValueRow,
  emailAddressView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(emailAddressView);

export class EmailAddressesStream extends LabeledValueStream {
  readonly name = 'emailAddresses';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per email address of a contact, a labeled value in the AddressBook table ZABCDEMAILADDRESS. ${labeledValue} distributionListConfigs.emailId refers to id. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = emailAddressView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.emailAddresses();
  }
}
