import {
  type AddressBookStore,
  type ValueRow,
  postalAddressView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(postalAddressView);

export class PostalAddressesStream extends LabeledValueStream {
  readonly name = 'postalAddresses';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per postal address of a contact, a labeled value in the AddressBook table ZABCDPOSTALADDRESS. ${labeledValue} distributionListConfigs.addressId refers to id. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = postalAddressView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.postalAddresses();
  }
}
