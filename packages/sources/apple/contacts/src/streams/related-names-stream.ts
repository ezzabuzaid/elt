import {
  type AddressBookStore,
  type ValueRow,
  relatedNameView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(relatedNameView);

export class RelatedNamesStream extends LabeledValueStream {
  readonly name = 'relatedNames';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per related name of a contact, a labeled value in the AddressBook table ZABCDRELATEDNAME. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = relatedNameView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.relatedNames();
  }
}
