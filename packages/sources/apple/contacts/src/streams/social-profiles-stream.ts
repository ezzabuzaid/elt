import {
  type AddressBookStore,
  type ValueRow,
  socialProfileView,
} from '@workspace/sdk-apple-contacts';

import { localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = labeledFields(socialProfileView);

export class SocialProfilesStream extends LabeledValueStream {
  readonly name = 'socialProfiles';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per social profile of a contact, a labeled value in the AddressBook table ZABCDSOCIALPROFILE. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = socialProfileView;

  protected rows(store: AddressBookStore): readonly ValueRow[] {
    return store.socialProfiles();
  }
}
