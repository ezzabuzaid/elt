import type { RecordDraft } from '@workspace/elt';
import type { AddressBookContact } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { text, nullableJid, nullableText, nullableInteger, nullableInstant } =
  whatsappFields;
const column = (what: string, name: string) => `${what} (${name}).`;

const properties = {
  uniqueId: {
    ...text,
    minLength: 1,
    description: column(
      'WhatsApp’s ID of this record; the primary key',
      'ZUNIQUEID',
    ),
  },
  whatsappId: {
    ...nullableJid,
    description: column(
      'The person’s WhatsApp JID by phone number',
      'ZWHATSAPPID',
    ),
  },
  lid: {
    ...nullableJid,
    description: column('The person’s LID; refers to users.lid', 'ZLID'),
  },
  interopJid: {
    ...nullableJid,
    description: column(
      'The person’s JID on another messaging service',
      'ZINTEROPJID',
    ),
  },
  identifier: {
    ...nullableText,
    description: column(
      'The macOS Contacts identifier of the card',
      'ZIDENTIFIER',
    ),
  },
  fullName: {
    ...nullableText,
    description: column('The full name', 'ZFULLNAME'),
  },
  givenName: {
    ...nullableText,
    description: column('The given name', 'ZGIVENNAME'),
  },
  lastName: {
    ...nullableText,
    description: column('The last name', 'ZLASTNAME'),
  },
  businessName: {
    ...nullableText,
    description: column('The business name', 'ZBUSINESSNAME'),
  },
  highlightedName: {
    ...nullableText,
    description: column('The name WhatsApp highlights', 'ZHIGHLIGHTEDNAME'),
  },
  username: {
    ...nullableText,
    description: column('The person’s WhatsApp username', 'ZUSERNAME'),
  },
  phoneNumber: {
    ...nullableText,
    description: column('The phone number, digits only', 'ZPHONENUMBER'),
  },
  localizedPhoneNumber: {
    ...nullableText,
    description: column(
      'The phone number as the card writes it',
      'ZLOCALIZEDPHONENUMBER',
    ),
  },
  phoneNumberLabel: {
    ...nullableText,
    description: column('The card’s label for the number', 'ZPHONENUMBERLABEL'),
  },
  phoneStatus: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented code for the number',
      'ZPHONESTATUS',
    ),
  },
  aboutText: {
    ...nullableText,
    description: column('The person’s About text', 'ZABOUTTEXT'),
  },
  aboutEmoji: {
    ...nullableText,
    description: column('The emoji of the person’s About', 'ZABOUTEMOJI'),
  },
  aboutTimestamp: {
    ...nullableInstant,
    description: column(
      'When the person set their About, UTC',
      'ZABOUTTIMESTAMP',
    ),
  },
  aboutExpirationTimestamp: {
    ...nullableInstant,
    description: column(
      'When the person’s About expires, UTC',
      'ZABOUTEXPIRATIONTIMESTAMP',
    ),
  },
  notes: { ...nullableText, description: column('The card’s notes', 'ZNOTES') },
  disappearingModeDuration: {
    ...nullableInteger,
    description: column(
      'The person’s default disappearing-message timer in seconds; 0 when off',
      'ZDISAPPEARINGMODEDURATION',
    ),
  },
  disappearingModeTimestamp: {
    ...nullableInstant,
    description: column(
      'When that timer was set, UTC',
      'ZDISAPPEARINGMODETIMESTAMP',
    ),
  },
  source: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented code for where the record came from',
      'ZSOURCE',
    ),
  },
  syncPolicy: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented sync policy code',
      'ZSYNCPOLICY',
    ),
  },
  lastUpdated: {
    ...nullableInstant,
    description: column(
      'When WhatsApp last updated the record, UTC',
      'ZLASTUPDATED',
    ),
  },
} as const;

export class ContactsStream extends WhatsAppStream<
  typeof properties,
  AddressBookContact
> {
  readonly name = 'contacts';
  readonly store = 'contacts';
  readonly primaryKey = ['uniqueId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per phone number in the Mac’s address book that WhatsApp found on WhatsApp (ContactsV2.sqlite’s ZWAADDRESSBOOKCONTACT). Primary key uniqueId. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly AddressBookContact[] {
    return scan.contacts.contacts();
  }

  protected record(
    contact: AddressBookContact,
  ): RecordDraft<typeof properties> {
    return { ...contact };
  }
}
