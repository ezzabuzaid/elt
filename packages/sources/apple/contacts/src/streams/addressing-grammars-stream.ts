import {
  type AddressBookStore,
  type ValueRow,
  addressingGrammarView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(addressingGrammarView);

export class AddressingGrammarsStream extends LabeledValueStream {
  readonly name = 'addressingGrammars';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per addressing grammar value of a contact, a labeled value in the AddressBook table ZABCDADDRESSINGGRAMMAR; the value is exported as stored and its format is not documented by Apple. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = addressingGrammarView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.addressingGrammars();
  }
}
