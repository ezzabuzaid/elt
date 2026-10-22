import type { RecordDraft } from '@workspace/elt';
import type { User } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, base64, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableText, nullableInteger, nullableInstant, nullableBase64 } =
  whatsappFields;
const column = (what: string, name: string) => `${what} (ZWAZACCOUNT.${name}).`;

const properties = {
  lid: {
    ...jid,
    description: column(
      'The user’s LID, the JID WhatsApp names them with in place of a phone number; the primary key',
      'ZIDENTIFIER',
    ),
  },
  phoneNumber: {
    ...nullableText,
    description: column(
      'The user’s phone number, digits only; <phoneNumber>@s.whatsapp.net is their phone JID. NULL when they do not share it',
      'ZPHONENUMBER',
    ),
  },
  countryCode: {
    ...nullableText,
    description: column('The country of the number, ISO 3166', 'ZCOUNTRYCODE'),
  },
  displayName: {
    ...nullableText,
    description: column('The name the user gave WhatsApp', 'ZDISPLAYNAME'),
  },
  username: {
    ...nullableText,
    description: column('The user’s WhatsApp username', 'ZUSERNAME'),
  },
  userType: {
    ...nullableInteger,
    description: column('WhatsApp’s undocumented user kind', 'ZUSERTYPE'),
  },
  state: {
    ...nullableInteger,
    description: column('WhatsApp’s undocumented state code', 'ZSTATE'),
  },
  phoneNumberSharingState: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented code for whether the user shares their number',
      'ZCURRENTPHONENUMBERSHARINGSTATE',
    ),
  },
  usernameState: {
    ...nullableInteger,
    description: column(
      'WhatsApp’s undocumented username state code',
      'ZUSERNAMESTATE',
    ),
  },
  createdAt: {
    ...nullableInstant,
    description: column(
      'When WhatsApp recorded the user, UTC; 0000-12-30, Foundation’s distant past, when it has no date',
      'ZCREATEDAT',
    ),
  },
  additionalData: {
    ...nullableBase64,
    description: column(
      'WhatsApp’s additional data, base64',
      'ZADDITIONALDATA',
    ),
  },
} as const;

export class UsersStream extends WhatsAppStream<typeof properties, User> {
  readonly name = 'users';
  readonly store = 'users';
  readonly primaryKey = ['lid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per WhatsApp user this account has seen, by LID, with the phone number when they share it (LID.sqlite). Join messages’ and members’ @lid JIDs here to reach a phone number. Primary key lid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<User> {
    return scan.users.users();
  }

  protected record({
    additionalData,
    ...user
  }: User): RecordDraft<typeof properties> {
    return { ...user, additionalData: base64(additionalData) };
  }
}
