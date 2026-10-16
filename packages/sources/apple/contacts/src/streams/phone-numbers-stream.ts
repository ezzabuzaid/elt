import {
  isSupportedCountry,
  parsePhoneNumberFromString,
} from 'libphonenumber-js';

import {
  type AddressBookStore,
  type ContactsValue,
  type ValueRow,
  phoneNumberView,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { explained, localStores } from '../contacts-fields.ts';
import type { ContactsScan } from '../contacts-scan.ts';
import {
  LabeledValueStream,
  labeledFields,
  labeledValue,
} from '../labeled-value-stream.ts';

const properties = explained(
  { ...labeledFields(phoneNumberView), e164: eventKitFields.nullableText },
  {
    e164: "fullNumber in E.164 form, such as +962791234567, the form Call History, Messages and WhatsApp keep numbers in. A number without a country code, such as 0791234567, is read in countryCode when the store holds one, else in the Mac's region (System Settings). NULL when fullNumber cannot be a phone number there, such as an SMS short code, or when it has no country code and the Mac has no region.",
  },
);

function e164(
  fullNumber: ContactsValue | undefined,
  countryCode: ContactsValue | undefined,
  region: string | null,
): string | null {
  if (typeof fullNumber !== 'string') return null;
  const country =
    typeof countryCode === 'string' ? countryCode.toUpperCase() : region;
  const parsed = parsePhoneNumberFromString(
    fullNumber,
    country !== null && isSupportedCountry(country) ? country : undefined,
  );
  return parsed?.isPossible() ? parsed.number : null;
}

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

  protected override records(
    row: ValueRow,
    store: AddressBookStore,
    scan: ContactsScan,
  ): Record<string, unknown>[] {
    return super.records(row, store, scan).map((record) => ({
      ...record,
      e164: e164(row.values.fullNumber, row.values.countryCode, scan.region),
    }));
  }
}
