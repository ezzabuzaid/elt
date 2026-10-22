import type { RecordDraft } from '@workspace/elt';
import type { BusinessProfile } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const {
  jid,
  text,
  nullableText,
  nullableInteger,
  nullableNumber,
  nullableBoolean,
  nullableInstant,
} = whatsappFields;
const profile = (what: string, column: string) =>
  `${what} (ZWABIZPROFILEDATA.${column}).`;

const properties = {
  jid: {
    ...jid,
    description: profile('The business, by phone JID; the primary key', 'ZJID'),
  },
  description: {
    ...nullableText,
    description: profile('The business’s About text', 'ZBUSINESSDESCRIPTION'),
  },
  address: { ...nullableText, description: profile('The address', 'ZADDRESS') },
  latitude: {
    ...nullableNumber,
    description: profile('The map pin’s latitude', 'ZLATITUDE'),
  },
  longitude: {
    ...nullableNumber,
    description: profile('The map pin’s longitude', 'ZLONGITUDE'),
  },
  email: {
    ...nullableText,
    description: profile('The email address', 'ZEMAIL'),
  },
  websites: {
    type: 'array',
    items: text,
    description: profile('The websites, in order', 'ZWEBSITES'),
  },
  timezone: {
    ...nullableText,
    description: profile('The time zone its hours are in, IANA', 'ZTIMEZONE'),
  },
  memberSinceDate: {
    ...nullableInstant,
    description: profile(
      'When the business joined WhatsApp, UTC',
      'ZMEMBERSINCEDATE',
    ),
  },
  memberSinceText: {
    ...nullableText,
    description: profile('That date as WhatsApp words it', 'ZMEMBERSINCETEXT'),
  },
  customUrl: {
    ...nullableText,
    description: profile('The business’s short link name', 'ZCUSTOMURL'),
  },
  vertical: {
    ...nullableText,
    description: profile('The industry', 'ZVERTICAL'),
  },
  canonicalVertical: {
    ...nullableText,
    description: profile(
      'The industry as WhatsApp files it',
      'ZCANONICALVERTICAL',
    ),
  },
  parentCompanyName: {
    ...nullableText,
    description: profile('The parent company', 'ZPARENTCOMPANYNAME'),
  },
  parentCompanyLogoUrl: {
    ...nullableText,
    description: profile('The parent company’s logo', 'ZPARENTCOMPANYLOGOURL'),
  },
  isAuthorizedAgent: {
    ...nullableBoolean,
    description: profile(
      'Whether it is an authorized agent',
      'ZISAUTHORIZEDAGENT',
    ),
  },
  commerceExperience: {
    ...nullableText,
    description:
      'Whether it sells through a catalog: none, catalog or smb_meta_catalog (ZWABIZPROFILEOPTIONSDATA.ZCOMMERCEEXPERIENCE).',
  },
  cartEnabled: {
    ...nullableBoolean,
    description: 'Whether its catalog has a cart (ZCARTENABLED).',
  },
  shopUrl: { ...nullableText, description: 'Its shop’s address (ZSHOPURL).' },
  isVideoCallingEnabled: {
    ...nullableBoolean,
    description: 'Whether it takes video calls (ZISVIDEOCALLINGENABLED).',
  },
  automatedType: {
    ...nullableText,
    description:
      'How far an automated agent answers its chats, such as 1p_partial (ZWABIZBOTDATA.ZAUTOMATEDTYPE).',
  },
  coverPhotoId: {
    ...nullableText,
    description: 'The cover photo’s ID (ZWABIZCOVERPHOTODATA.ZIMAGEID).',
  },
  coverPhotoUrl: {
    ...nullableText,
    description:
      'The cover photo on WhatsApp’s servers; the link expires (ZURL).',
  },
  facebookPageId: {
    ...nullableText,
    description: 'Its linked Facebook page’s ID (ZLINKEDACCOUNTS field 1.1).',
  },
  facebookPageName: {
    ...nullableText,
    description: 'Its linked Facebook page’s name (field 1.2).',
  },
  facebookLikes: {
    ...nullableInteger,
    description: 'That page’s likes (field 1.3).',
  },
  instagramHandle: {
    ...nullableText,
    description: 'Its linked Instagram account (field 2.1).',
  },
  instagramFollowers: {
    ...nullableInteger,
    description: 'That account’s followers (field 2.2).',
  },
} as const;

export class BusinessProfilesStream extends WhatsAppStream<
  typeof properties,
  BusinessProfile
> {
  readonly name = 'businessProfiles';
  readonly store = 'businesses';
  readonly primaryKey = ['jid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per business profile WhatsApp fetched for a chat with a business (Biz.sqlite), as the profile screen shows it. Primary key jid; a chat may name the business by its LID instead, which businessVerifiedNames maps. Not narrowed by an import’s chats or dates.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<BusinessProfile> {
    return scan.businesses.profiles();
  }

  protected record(profile: BusinessProfile): RecordDraft<typeof properties> {
    return { ...profile, websites: [...profile.websites] };
  }
}
