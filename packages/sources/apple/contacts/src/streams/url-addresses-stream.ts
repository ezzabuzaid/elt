import {
  type AddressBookStore,
  type ValueRow,
  urlAddressView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(urlAddressView);

export class UrlAddressesStream extends LabeledValueStream {
  readonly name = 'urlAddresses';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per URL of a contact, a labeled value in the AddressBook table ZABCDURLADDRESS. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = urlAddressView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.urlAddresses();
  }
}
