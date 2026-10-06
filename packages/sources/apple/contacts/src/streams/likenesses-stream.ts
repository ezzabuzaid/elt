import {
  type AddressBookStore,
  type ValueRow,
  likenessView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(likenessView);

export class LikenessesStream extends LabeledValueStream {
  readonly name = 'likenesses';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per likeness value of a contact, a labeled value in the AddressBook table ZABCDLIKENESS; kind, version and data are exported as stored and their meaning is not documented by Apple. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = likenessView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.likenesses();
  }
}
