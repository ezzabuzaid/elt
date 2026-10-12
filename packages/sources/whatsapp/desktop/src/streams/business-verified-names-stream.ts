import type { RecordDraft } from '@workspace/elt';
import type { BusinessVerifiedName } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const { jid, nullableJid, nullableText, nullableInteger, nullableInstant } =
  whatsappFields;
const second = { ...nullableText, format: 'date-time', precision: 0 } as const;

const properties = {
  lid: {
    ...jid,
    description:
      'The business’s LID; the primary key (ZWABIZVERIFIEDNAMEDATA.ZJID).',
  },
  phoneNumberJid: {
    ...nullableJid,
    description:
      'The business’s phone JID; refers to businessProfiles.jid (ZPHONENUMBERJID).',
  },
  name: {
    ...nullableText,
    description: 'The name WhatsApp verified for the business (ZNAME).',
  },
  verificationLevel: {
    ...nullableInteger,
    description:
      'How far WhatsApp verified it: 1 unknown, 2 low, 3 high (ZVERIFICATIONLEVEL).',
  },
  expires: {
    ...nullableInstant,
    description: 'When the verification expires, UTC (ZEXPIRES).',
  },
  certificateSerial: {
    ...nullableText,
    format: 'int64',
    description: 'The name certificate’s serial (ZCERTIFICATEDETAILS field 1).',
  },
  certificateIssuer: {
    ...nullableText,
    description:
      'Who issued the certificate: smb:wa for the WhatsApp Business app, ent:wa for WhatsApp’s business platform (field 2).',
  },
  certificateIssuedAt: {
    ...second,
    description: 'When the certificate was issued, UTC (field 10).',
  },
  roleActor: {
    ...nullableInteger,
    description:
      'For a business on WhatsApp’s business platform, the server’s undocumented actor code: who answers its chats (ZWABIZROLEDATA.ZACTOR).',
  },
  roleHostStorage: {
    ...nullableInteger,
    description:
      'The server’s undocumented code for where the business’s chats are stored (ZHOSTSTORAGE).',
  },
  roleUpdatedAt: {
    ...second,
    description: 'When the server last set that role, UTC (ZLASTUPDATETIME).',
  },
} as const;

export class BusinessVerifiedNamesStream extends WhatsAppStream<
  typeof properties,
  BusinessVerifiedName
> {
  readonly name = 'businessVerifiedNames';
  readonly store = 'businesses';
  readonly primaryKey = ['lid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per business WhatsApp holds a verified name for, by LID, with the platform role of a business on WhatsApp’s business platform (Biz.sqlite). Primary key lid. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly BusinessVerifiedName[] {
    return scan.businesses.verifiedNames();
  }

  protected record(name: BusinessVerifiedName): RecordDraft<typeof properties> {
    return { ...name };
  }
}
