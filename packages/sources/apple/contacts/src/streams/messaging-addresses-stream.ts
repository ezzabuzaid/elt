import {
  type AddressBookStore,
  type MessagingAddressRow,
  messagingAddressView,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { explained, localStores } from '../contacts-fields.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = explained(
  {
    ...labeledFields(messagingAddressView),
    service: eventKitFields.nullableText,
  },
  {
    service:
      'Service name as stored: AddressBook ZABCDSERVICE.ZSERVICENAME of the service record ZABCDMESSAGINGADDRESS.ZSERVICE references, such as SkypeInstant; NULL when unset or no service record matches.',
  },
);

// Instant message addresses; service is ABCDService's name, such as SkypeInstant.
export class MessagingAddressesStream extends LabeledValueStream<MessagingAddressRow> {
  readonly name = 'messagingAddresses';
  readonly jsonSchema = {
    type: 'object',
    description: `One row per instant messaging address of a contact, a labeled value in the AddressBook table ZABCDMESSAGINGADDRESS. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;
  protected readonly view = messagingAddressView;

  protected rows(store: AddressBookStore): readonly MessagingAddressRow[] {
    return store.messagingAddresses();
  }

  protected override records(
    row: MessagingAddressRow,
  ): Record<string, unknown>[] {
    return super.records(row).map((record) => ({
      ...record,
      service: row.service,
    }));
  }
}
