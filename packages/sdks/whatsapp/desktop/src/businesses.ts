import { Snapshot, type SnapshotColumns } from '@zukhruf/sqlite-snapshot';

import { decodeArchive, isDictionary } from '@workspace/codec-plist';
import { ProtobufMessage } from '@workspace/codec-protobuf';

import { WhatsAppSchemaError, WhatsAppUnavailableError } from './errors.ts';
import {
  bytes,
  flag,
  instant,
  number,
  requiredText,
  text,
  unixSecondInstant,
} from './values.ts';

// A business's WhatsApp profile as WhatsApp fetched it for a chat
// (ZWABIZPROFILEDATA), with its options, bot, cover photo and linked
// Facebook and Instagram accounts.
export type BusinessProfile = {
  readonly jid: string;
  readonly description: string | null;
  readonly address: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly email: string | null;
  readonly websites: readonly string[];
  readonly timezone: string | null;
  readonly memberSinceDate: string | null;
  readonly memberSinceText: string | null;
  readonly customUrl: string | null;
  readonly vertical: string | null;
  readonly canonicalVertical: string | null;
  readonly parentCompanyName: string | null;
  readonly parentCompanyLogoUrl: string | null;
  readonly isAuthorizedAgent: boolean | null;
  readonly commerceExperience: string | null;
  readonly cartEnabled: boolean | null;
  readonly shopUrl: string | null;
  readonly isVideoCallingEnabled: boolean | null;
  readonly automatedType: string | null;
  readonly coverPhotoId: string | null;
  readonly coverPhotoUrl: string | null;
  readonly facebookPageId: string | null;
  readonly facebookPageName: string | null;
  readonly facebookLikes: number | null;
  readonly instagramHandle: string | null;
  readonly instagramFollowers: number | null;
};

// A verified business name, keyed by the business's LID
// (ZWABIZVERIFIEDNAMEDATA), with how WhatsApp's servers host the business's
// chats (ZWABIZROLEDATA) when it uses WhatsApp's business platform.
export type BusinessVerifiedName = {
  readonly lid: string;
  readonly phoneNumberJid: string | null;
  readonly name: string | null;
  readonly verificationLevel: number | null;
  readonly expires: string | null;
  // The certificate's serial, as text: it passes 2^53.
  readonly certificateSerial: string | null;
  readonly certificateIssuer: string | null;
  readonly certificateIssuedAt: string | null;
  readonly roleActor: number | null;
  readonly roleHostStorage: number | null;
  readonly roleUpdatedAt: string | null;
};

export type BusinessCategory = {
  readonly jid: string;
  readonly position: number;
  readonly categoryId: string;
  readonly name: string | null;
};

// The hours of one day; days a business is closed have none.
export type BusinessHours = {
  readonly jid: string;
  // 1 is Sunday through 7, Saturday.
  readonly day: number;
  readonly mode: number;
  // Minutes after midnight in the business's time zone.
  readonly openTime: number;
  readonly closeTime: number;
};

export type BusinessServiceArea = {
  readonly jid: string;
  readonly position: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly radiusMeters: number | null;
  readonly description: string | null;
};

export type BusinessBotPrompt = {
  readonly jid: string;
  readonly position: number;
  readonly text: string;
  readonly emoji: string | null;
};

const requiredColumns = {
  ZWABIZPROFILEDATA: [
    'Z_PK',
    'ZJID',
    'ZBUSINESSDESCRIPTION',
    'ZADDRESS',
    'ZLATITUDE',
    'ZLONGITUDE',
    'ZEMAIL',
    'ZWEBSITES',
    'ZHOURSCONFIGS',
    'ZTIMEZONE',
    'ZMEMBERSINCEDATE',
    'ZMEMBERSINCETEXT',
    'ZCUSTOMURL',
    'ZVERTICAL',
    'ZCANONICALVERTICAL',
    'ZPARENTCOMPANYNAME',
    'ZPARENTCOMPANYLOGOURL',
    'ZISAUTHORIZEDAGENT',
    'ZLINKEDACCOUNTS',
    'ZPROFILEOPTIONS',
    'ZBOTDATA',
    'ZCOVERPHOTO',
  ],
  ZWABIZPROFILEOPTIONSDATA: [
    'Z_PK',
    'ZCOMMERCEEXPERIENCE',
    'ZCARTENABLED',
    'ZSHOPURL',
    'ZISVIDEOCALLINGENABLED',
  ],
  ZWABIZBOTDATA: ['Z_PK', 'ZAUTOMATEDTYPE'],
  ZWABIZCOVERPHOTODATA: ['Z_PK', 'ZIMAGEID', 'ZURL'],
  ZWABIZCATEGORYDATA: [
    'Z_PK',
    'ZPROFILE',
    'Z_FOK_PROFILE',
    'ZCATEGORYID',
    'ZNAME',
  ],
  ZWABIZSERVICEAREADATA: [
    'Z_PK',
    'ZPROFILE',
    'ZLATITUDE',
    'ZLONGITUDE',
    'ZAREARADIUSMETERS',
    'ZAREADESCRIPTION',
  ],
  ZWABIZBOTPROMPTDATA: ['Z_PK', 'ZBOTDATA', 'Z_FOK_BOTDATA', 'ZTEXT', 'ZEMOJI'],
  ZWABIZVERIFIEDNAMEDATA: [
    'Z_PK',
    'ZJID',
    'ZPHONENUMBERJID',
    'ZNAME',
    'ZVERIFICATIONLEVEL',
    'ZEXPIRES',
    'ZCERTIFICATEDETAILS',
  ],
  ZWABIZROLEDATA: ['Z_PK', 'ZJID', 'ZACTOR', 'ZHOSTSTORAGE', 'ZLASTUPDATETIME'],
} satisfies SnapshotColumns;

// A value an NSKeyedArchiver archive holds, as the codec unarchives it.
function archived(value: unknown): unknown {
  const archive = bytes(value);
  return archive === null ? null : decodeArchive(archive);
}

// A protobuf WhatsApp archives as a GPBMessage: its bytes under GPBData.
function archivedProtobuf(value: unknown): ProtobufMessage | null {
  const decoded = archived(value);
  if (decoded === null) return null;
  if (!isDictionary(decoded))
    throw new TypeError('A WhatsApp business blob holds no protobuf message');
  const { GPBData } = decoded;
  return new ProtobufMessage(
    GPBData === undefined
      ? new Uint8Array()
      : (bytes(GPBData) ?? new Uint8Array()),
  );
}

// Biz/Biz.sqlite as of one moment: the profiles of businesses this account
// chats with, which WhatsApp fetches and keeps. Left out: the server's
// profile version tags, internal flags and the one marketing token.
export class BusinessesSnapshot implements Disposable {
  readonly #database: Snapshot;

  constructor(path: string) {
    this.#database = new Snapshot(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
  }

  profiles(): IteratorObject<BusinessProfile, undefined> {
    return this.#database
      .iterate(
        `SELECT profile.ZJID AS jid,
                profile.ZBUSINESSDESCRIPTION AS description,
                profile.ZADDRESS AS address, profile.ZLATITUDE AS latitude,
                profile.ZLONGITUDE AS longitude, profile.ZEMAIL AS email,
                profile.ZWEBSITES AS websites, profile.ZTIMEZONE AS timezone,
                profile.ZMEMBERSINCEDATE AS memberSinceDate,
                profile.ZMEMBERSINCETEXT AS memberSinceText,
                profile.ZCUSTOMURL AS customUrl, profile.ZVERTICAL AS vertical,
                profile.ZCANONICALVERTICAL AS canonicalVertical,
                profile.ZPARENTCOMPANYNAME AS parentCompanyName,
                profile.ZPARENTCOMPANYLOGOURL AS parentCompanyLogoUrl,
                profile.ZISAUTHORIZEDAGENT AS isAuthorizedAgent,
                profile.ZLINKEDACCOUNTS AS linkedAccounts,
                options.ZCOMMERCEEXPERIENCE AS commerceExperience,
                options.ZCARTENABLED AS cartEnabled,
                options.ZSHOPURL AS shopUrl,
                options.ZISVIDEOCALLINGENABLED AS isVideoCallingEnabled,
                bot.ZAUTOMATEDTYPE AS automatedType,
                cover.ZIMAGEID AS coverPhotoId, cover.ZURL AS coverPhotoUrl
         FROM ZWABIZPROFILEDATA AS profile
         LEFT JOIN ZWABIZPROFILEOPTIONSDATA AS options
           ON options.Z_PK = profile.ZPROFILEOPTIONS
         LEFT JOIN ZWABIZBOTDATA AS bot ON bot.Z_PK = profile.ZBOTDATA
         LEFT JOIN ZWABIZCOVERPHOTODATA AS cover
           ON cover.Z_PK = profile.ZCOVERPHOTO
         ORDER BY profile.Z_PK`,
      )
      .map((row) => {
        // WAPBBizProfileLinkedAccounts: 1 Facebook {1 page ID, 2 page name,
        // 3 likes}, 2 Instagram {1 handle, 2 followers}.
        const linked = archivedProtobuf(row.linkedAccounts);
        const facebook = linked?.message(1);
        const instagram = linked?.message(2);
        return {
          jid: requiredText(row.jid, 'A WhatsApp business has no JID'),
          description: text(row.description),
          address: text(row.address),
          latitude: number(row.latitude),
          longitude: number(row.longitude),
          email: text(row.email),
          websites: websites(row.websites),
          timezone: text(row.timezone),
          memberSinceDate: instant(row.memberSinceDate),
          memberSinceText: text(row.memberSinceText),
          customUrl: text(row.customUrl),
          vertical: text(row.vertical),
          canonicalVertical: text(row.canonicalVertical),
          parentCompanyName: text(row.parentCompanyName),
          parentCompanyLogoUrl: text(row.parentCompanyLogoUrl),
          isAuthorizedAgent: flag(row.isAuthorizedAgent),
          commerceExperience: text(row.commerceExperience),
          cartEnabled: flag(row.cartEnabled),
          shopUrl: text(row.shopUrl),
          isVideoCallingEnabled: flag(row.isVideoCallingEnabled),
          automatedType: text(row.automatedType),
          coverPhotoId: text(row.coverPhotoId),
          coverPhotoUrl: text(row.coverPhotoUrl),
          facebookPageId: facebook?.string(1) ?? null,
          facebookPageName: facebook?.string(2) ?? null,
          facebookLikes: facebook?.uint(3) ?? null,
          instagramHandle: instagram?.string(1) ?? null,
          instagramFollowers: instagram?.uint(2) ?? null,
        };
      });
  }

  verifiedNames(): IteratorObject<BusinessVerifiedName, undefined> {
    return this.#database
      .iterate(
        `SELECT name.ZJID AS lid, name.ZPHONENUMBERJID AS phoneNumberJid,
                name.ZNAME AS name,
                name.ZVERIFICATIONLEVEL AS verificationLevel,
                name.ZEXPIRES AS expires,
                name.ZCERTIFICATEDETAILS AS certificate,
                role.ZACTOR AS roleActor, role.ZHOSTSTORAGE AS roleHostStorage,
                role.ZLASTUPDATETIME AS roleUpdatedAt
         FROM ZWABIZVERIFIEDNAMEDATA AS name
         LEFT JOIN ZWABIZROLEDATA AS role ON role.ZJID = name.ZJID
         ORDER BY name.Z_PK`,
      )
      .map((row) => {
        // WAPBVerifiedNameCertificate_Details: 1 serial, 2 issuer, 10 issue
        // time in Unix seconds.
        const certificate = archivedProtobuf(row.certificate);
        return {
          lid: requiredText(row.lid, 'A WhatsApp verified name has no LID'),
          phoneNumberJid: text(row.phoneNumberJid),
          name: text(row.name),
          verificationLevel: number(row.verificationLevel),
          expires: instant(row.expires),
          certificateSerial: certificate?.uint64(1)?.toString() ?? null,
          certificateIssuer: certificate?.string(2) ?? null,
          certificateIssuedAt: unixSecondInstant(certificate?.uint(10)),
          roleActor: number(row.roleActor),
          roleHostStorage: number(row.roleHostStorage),
          roleUpdatedAt: unixSecondInstant(number(row.roleUpdatedAt)),
        };
      });
  }

  categories(): IteratorObject<BusinessCategory, undefined> {
    const position = positions();
    return this.#database
      .iterate(
        `SELECT profile.ZJID AS jid, category.ZCATEGORYID AS categoryId,
                category.ZNAME AS name
         FROM ZWABIZCATEGORYDATA AS category
         JOIN ZWABIZPROFILEDATA AS profile ON profile.Z_PK = category.ZPROFILE
         ORDER BY profile.Z_PK, category.Z_FOK_PROFILE, category.Z_PK`,
      )
      .map((row) => ({
        jid: requiredText(row.jid, 'A WhatsApp business has no JID'),
        position: position(row),
        categoryId: requiredText(
          row.categoryId,
          'A WhatsApp business category has no ID',
        ),
        name: text(row.name),
      }));
  }

  hours(): IteratorObject<BusinessHours, undefined> {
    return this.#database
      .iterate(
        `SELECT ZJID AS jid, ZHOURSCONFIGS AS hours FROM ZWABIZPROFILEDATA
         WHERE ZHOURSCONFIGS IS NOT NULL ORDER BY Z_PK`,
      )
      .flatMap((row) => {
        const jid = requiredText(row.jid, 'A WhatsApp business has no JID');
        const configs = archived(row.hours);
        if (!Array.isArray(configs))
          throw new TypeError('WhatsApp business hours are not a list');
        return configs.map((config) => {
          if (!isDictionary(config))
            throw new TypeError('WhatsApp business hours are not a list');
          const { day, mode, openTime, closeTime } = config;
          if (
            typeof day !== 'number' ||
            typeof mode !== 'number' ||
            typeof openTime !== 'number' ||
            typeof closeTime !== 'number'
          )
            throw new TypeError('WhatsApp business hours lack a field');
          return { jid, day, mode, openTime, closeTime };
        });
      });
  }

  serviceAreas(): IteratorObject<BusinessServiceArea, undefined> {
    const position = positions();
    return this.#database
      .iterate(
        `SELECT profile.ZJID AS jid, area.ZLATITUDE AS latitude,
                area.ZLONGITUDE AS longitude,
                area.ZAREARADIUSMETERS AS radiusMeters,
                area.ZAREADESCRIPTION AS description
         FROM ZWABIZSERVICEAREADATA AS area
         JOIN ZWABIZPROFILEDATA AS profile ON profile.Z_PK = area.ZPROFILE
         ORDER BY profile.Z_PK, area.Z_PK`,
      )
      .map((row) => ({
        jid: requiredText(row.jid, 'A WhatsApp business has no JID'),
        position: position(row),
        latitude: number(row.latitude),
        longitude: number(row.longitude),
        radiusMeters: number(row.radiusMeters),
        description: text(row.description),
      }));
  }

  botPrompts(): IteratorObject<BusinessBotPrompt, undefined> {
    const position = positions();
    return this.#database
      .iterate(
        `SELECT profile.ZJID AS jid, prompt.ZTEXT AS text,
                prompt.ZEMOJI AS emoji
         FROM ZWABIZBOTPROMPTDATA AS prompt
         JOIN ZWABIZPROFILEDATA AS profile ON profile.ZBOTDATA = prompt.ZBOTDATA
         ORDER BY profile.Z_PK, prompt.Z_FOK_BOTDATA, prompt.Z_PK`,
      )
      .map((row) => ({
        jid: requiredText(row.jid, 'A WhatsApp business has no JID'),
        position: position(row),
        text: requiredText(row.text, 'A WhatsApp business prompt has no text'),
        emoji: text(row.emoji),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}

function websites(value: unknown): string[] {
  const decoded = archived(value);
  if (decoded === null) return [];
  if (
    !Array.isArray(decoded) ||
    !decoded.every((url) => typeof url === 'string')
  )
    throw new TypeError('WhatsApp business websites are not a list of text');
  return decoded;
}

// Each row's place among the rows of its business, counted as the rows come
// in business order, so no read needs the rows before it.
function positions(): (row: Readonly<Record<string, unknown>>) => number {
  let business: unknown;
  let next = 0;
  return (row) => {
    if (row.jid !== business) {
      business = row.jid;
      next = 0;
    }
    return next++;
  };
}
