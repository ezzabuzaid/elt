import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  Connection,
  Copy,
  CopyConfiguration,
  type CopyResult,
  LocalFiles,
  Pipeline,
  PipelineError,
  type Stream,
  StreamStatus,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  WhatsAppSchemaError,
  WhatsAppUnavailableError,
  whatsappContainer,
} from '@workspace/sdk-whatsapp-desktop';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { WhatsAppDesktopSource } from './whatsapp-desktop-source.ts';

// Each WhatsApp store, with the tables this reader reads as WhatsApp 26.38's
// models create them, in WAL mode as WhatsApp keeps them.
const stores = {
  chatStorage: {
    file: 'ChatStorage.sqlite',
    schema: `
      CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
      CREATE TABLE ZWABLACKLISTITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR );
      CREATE TABLE ZWACHATPUSHCONFIG ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZALERTS INTEGER, ZMUTEDUNTIL TIMESTAMP, ZJID VARCHAR, ZRINGTONE VARCHAR, ZSOUND VARCHAR );
      CREATE TABLE ZWACHATSESSION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZARCHIVED INTEGER, ZCONTACTABID INTEGER, ZFLAGS INTEGER, ZHIDDEN INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZMESSAGECOUNTER INTEGER, ZREMOVED INTEGER, ZSESSIONTYPE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZUNREADCOUNT INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER, ZPROPERTIES INTEGER, ZLASTMESSAGEDATE TIMESTAMP, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTJID VARCHAR, ZETAG VARCHAR, ZLASTMESSAGETEXT VARCHAR, ZPARTNERNAME VARCHAR, ZSAVEDINPUT VARCHAR );
      CREATE TABLE ZWAGROUPINFO ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSTATE INTEGER, ZCHATSESSION INTEGER, ZLASTMESSAGEOWNER INTEGER, ZCREATIONDATE TIMESTAMP, ZSUBJECTTIMESTAMP TIMESTAMP, ZCREATORJID VARCHAR, ZOWNERJID VARCHAR, ZPICTUREID VARCHAR, ZPICTUREPATH VARCHAR, ZSOURCEJID VARCHAR, ZSUBJECTOWNERJID VARCHAR );
      CREATE TABLE ZWAGROUPMEMBER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTABID INTEGER, ZISACTIVE INTEGER, ZISADMIN INTEGER, ZSENDERKEYSENT INTEGER, ZCHATSESSION INTEGER, ZRECENTGROUPCHAT INTEGER, ZCONTACTIDENTIFIER VARCHAR, ZCONTACTNAME VARCHAR, ZFIRSTNAME VARCHAR, ZMEMBERJID VARCHAR );
      CREATE TABLE ZWAGROUPMEMBERSCHANGE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHANGETYPE INTEGER, ZCHANGEDATE TIMESTAMP, ZGROUPJID VARCHAR, ZMEMBERJIDS VARCHAR, ZPHASHBEFORECHANGE VARCHAR );
      CREATE TABLE ZWAMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCLOUDSTATUS INTEGER, ZFILESIZE INTEGER, ZMEDIAORIGIN INTEGER, ZMOVIEDURATION INTEGER, ZMESSAGE INTEGER, ZASPECTRATIO FLOAT, ZHACCURACY FLOAT, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZMEDIAURLDATE TIMESTAMP, ZAUTHORNAME VARCHAR, ZCOLLECTIONNAME VARCHAR, ZMEDIALOCALPATH VARCHAR, ZMEDIAURL VARCHAR, ZTHUMBNAILLOCALPATH VARCHAR, ZTITLE VARCHAR, ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZXMPPTHUMBPATH VARCHAR, ZMEDIAKEY BLOB, ZMETADATA BLOB );
      CREATE TABLE ZWAMESSAGE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER, ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER, ZDOCID INTEGER, ZENCRETRYCOUNT INTEGER, ZFILTEREDRECIPIENTCOUNT INTEGER, ZFLAGS INTEGER, ZGROUPEVENTTYPE INTEGER, ZISFROMME INTEGER, ZMESSAGEERRORSTATUS INTEGER, ZMESSAGESTATUS INTEGER, ZMESSAGETYPE INTEGER, ZSORT INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSTARRED INTEGER, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER, ZPARENTMESSAGE INTEGER, ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZFROMJID VARCHAR, ZMEDIASECTIONID VARCHAR, ZPHASH VARCHAR, ZPUSHNAME VARCHAR, ZSTANZAID VARCHAR, ZTEXT VARCHAR, ZTOJID VARCHAR );
      CREATE TABLE ZWAMESSAGEDATAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINDEX INTEGER, ZOWNSTHUMBNAIL INTEGER, ZTYPE INTEGER, ZMESSAGE INTEGER, ZDATE TIMESTAMP, ZCHATJID VARCHAR, ZCONTENT1 VARCHAR, ZCONTENT2 VARCHAR, ZMATCHEDTEXT VARCHAR, ZSECTIONID VARCHAR, ZSENDERJID VARCHAR, ZSUMMARY VARCHAR, ZTHUMBNAILPATH VARCHAR, ZTITLE VARCHAR );
      CREATE TABLE ZWAMESSAGEINFO ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMESSAGE INTEGER, ZRECEIPTINFO BLOB );
      CREATE TABLE ZWAPROFILEPICTUREITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZREQUESTDATE TIMESTAMP, ZJID VARCHAR, ZPATH VARCHAR, ZPICTUREID VARCHAR );
      CREATE TABLE ZWAPROFILEPUSHNAME ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR );
    `,
  },
  contacts: {
    file: 'ContactsV2.sqlite',
    schema: `
      CREATE TABLE ZWAADDRESSBOOKCONTACT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDISAPPEARINGMODEDURATION INTEGER, ZPHONESTATUS INTEGER, ZSECTIONSORT INTEGER, ZSORT INTEGER, ZSOURCE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSYNCPOLICY INTEGER, ZSYNCWITHSERVERSTATE INTEGER, ZABOUTEXPIRATIONTIMESTAMP TIMESTAMP, ZABOUTTIMESTAMP TIMESTAMP, ZDISAPPEARINGMODETIMESTAMP TIMESTAMP, ZLASTUPDATED TIMESTAMP, ZABOUTEMOJI VARCHAR, ZABOUTTEXT VARCHAR, ZBUSINESSNAME VARCHAR, ZFULLNAME VARCHAR, ZGIVENNAME VARCHAR, ZHIGHLIGHTEDNAME VARCHAR, ZIDENTIFIER VARCHAR, ZINTEROPJID VARCHAR, ZLASTNAME VARCHAR, ZLID VARCHAR, ZLIDHASH VARCHAR, ZLOCALIZEDPHONENUMBER VARCHAR, ZNOTES VARCHAR, ZPHONENUMBER VARCHAR, ZPHONENUMBERLABEL VARCHAR, ZPNHASH VARCHAR, ZSEARCHTOKENLIST VARCHAR, ZSECTIONTITLE VARCHAR, ZUNIQUEID VARCHAR, ZUSERNAME VARCHAR, ZWHATSAPPID VARCHAR, ZDEVICELIST BLOB );
    `,
  },
  users: {
    file: 'LID.sqlite',
    schema: `
      CREATE TABLE ZWAZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCURRENTPHONENUMBERSHARINGSTATE INTEGER, ZSTATE INTEGER, ZUSERTYPE INTEGER, ZUSERNAMESTATE INTEGER, ZCREATEDAT TIMESTAMP, ZCOUNTRYCODE VARCHAR, ZDISPLAYNAME VARCHAR, ZIDENTIFIER VARCHAR, ZPHONENUMBER VARCHAR, ZUSERNAME VARCHAR, ZADDITIONALDATA BLOB );
    `,
  },
  calls: {
    file: 'CallHistory.sqlite',
    schema: `
      CREATE TABLE ZWAAGGREGATECALLEVENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINCOMING INTEGER, ZMISSED INTEGER, ZMISSEDREASON INTEGER, ZVIDEO INTEGER, ZFIRSTDATE TIMESTAMP, ZLINKTOKEN VARCHAR );
      CREATE TABLE ZWACDCALLEVENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZBYTESRECEIVED INTEGER, ZBYTESSENT INTEGER, ZISBOTGROUPCALL INTEGER, ZISLIGHTWEIGHT INTEGER, ZOUTCOME INTEGER, Z1CALLEVENTS INTEGER, Z_FOK_1CALLEVENTS INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZCALLIDSTRING VARCHAR, ZGROUPCALLCREATORUSERJIDSTRING VARCHAR, ZGROUPJIDSTRING VARCHAR, ZREMINDERID VARCHAR, ZSCHEDULEDID VARCHAR );
      CREATE TABLE ZWACDCALLEVENTPARTICIPANT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOUTCOME INTEGER, Z1PARTICIPANTS INTEGER, Z_FOK_1PARTICIPANTS INTEGER, ZJIDSTRING VARCHAR );
    `,
  },
  messageAssociations: {
    file: 'ExtChatDB/ExtChatDatabase.sqlite',
    schema: `
      CREATE TABLE message_parent_association( stanza_id TEXT NOT NULL, parent_stanza_id TEXT NOT NULL, type INTEGER NOT NULL, sort LONG_INT NOT NULL, chat_jid TEXT NOT NULL, PRIMARY KEY (stanza_id, chat_jid, type) );
    `,
  },
  businesses: {
    file: 'Biz/Biz.sqlite',
    schema: `
      CREATE TABLE ZWABIZBOTDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZISTYPINGINDICATORENABLED INTEGER, ZPROFILE INTEGER, ZAUTOMATEDTYPE VARCHAR, ZBOTDESCRIPTION VARCHAR, ZBOTSUBDESCRIPTION VARCHAR, ZCALLINGAUTOMATEDTYPE VARCHAR, ZCOMMANDSDESCRIPTION VARCHAR );
      CREATE TABLE ZWABIZBOTPROMPTDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZBOTDATA INTEGER, Z_FOK_BOTDATA INTEGER, ZEMOJI VARCHAR, ZTEXT VARCHAR );
      CREATE TABLE ZWABIZCATEGORYDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPROFILE INTEGER, Z_FOK_PROFILE INTEGER, ZCATEGORYID VARCHAR, ZNAME VARCHAR );
      CREATE TABLE ZWABIZCOVERPHOTODATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPROFILE INTEGER, ZIMAGEID VARCHAR, ZURL VARCHAR );
      CREATE TABLE ZWABIZPROFILEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFLAGS INTEGER, ZISAUTHORIZEDAGENT INTEGER, ZTAG INTEGER, ZBOTDATA INTEGER, ZCOVERPHOTO INTEGER, ZCURRENTPRICETIER INTEGER, ZDIRECTCONNECTION INTEGER, ZPROFILEOPTIONS INTEGER, ZSTRUCTUREDADDRESS INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZMEMBERSINCEDATE TIMESTAMP, ZADDRESS VARCHAR, ZBUSINESSDESCRIPTION VARCHAR, ZCANONICALVERTICAL VARCHAR, ZCUSTOMURL VARCHAR, ZEMAIL VARCHAR, ZJID VARCHAR, ZMEMBERSINCETEXT VARCHAR, ZOBAPHONENUMBER VARCHAR, ZPARENTCOMPANYLOGOURL VARCHAR, ZPARENTCOMPANYNAME VARCHAR, ZTIMEZONE VARCHAR, ZVERTICAL VARCHAR, ZWELCOMEMESSAGEPROTOCOLMODE VARCHAR, ZCALLHOURSDATA BLOB, ZHOURSCONFIGS BLOB, ZLINKEDACCOUNTS BLOB, ZPILLS BLOB, ZWEBSITES BLOB );
      CREATE TABLE ZWABIZPROFILEOPTIONSDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCALLINGHIDDENENTRYPOINTS INTEGER, ZCARTENABLED INTEGER, ZDIRECTCONNECTION INTEGER, ZFLAGS INTEGER, ZISOFFERINGSELIGIBLE INTEGER, ZISSHOPBANNED INTEGER, ZISVIDEOCALLINGENABLED INTEGER, ZAUTOMATEDGREETINGMESSAGE INTEGER, ZPROFILE INTEGER, ZCALLINGCOUNTRYALLOWLIST VARCHAR, ZCOMMERCEEXPERIENCE VARCHAR, ZCOMMERCEMANAGERURL VARCHAR, ZDEFAULTCALLPERMISSIONPARAMS VARCHAR, ZSHOPURL VARCHAR );
      CREATE TABLE ZWABIZROLEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACTOR INTEGER, ZHOSTSTORAGE INTEGER, ZLASTUPDATETIME INTEGER, ZJID VARCHAR, ZPHONENUMBERJID VARCHAR, ZIDENTITY BLOB );
      CREATE TABLE ZWABIZSERVICEAREADATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZAREARADIUSMETERS INTEGER, ZPROFILE INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZAREADESCRIPTION VARCHAR );
      CREATE TABLE ZWABIZVERIFIEDNAMEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZVERIFICATIONLEVEL INTEGER, ZEXPIRES TIMESTAMP, ZJID VARCHAR, ZNAME VARCHAR, ZPHONENUMBERJID VARCHAR, ZCERTIFICATEDETAILS BLOB );
    `,
  },
  statuses: {
    file: 'statusDB/Status.sqlite',
    schema: `
      CREATE TABLE status( row_id INTEGER PRIMARY KEY AUTOINCREMENT, sort_id LONG_INT NOT NULL, uuid TEXT NOT NULL, sender_user_jid TEXT NOT NULL, status_info_row_id INTEGER NOT NULL, type INTEGER NOT NULL, timestamp LONG_INT NOT NULL, server_receipt_timestamp LONG_INT, text_data TEXT, state INTEGER NOT NULL, secret BLOB, content_proto BLOB, fp_proto BLOB, origin INTEGER NOT NULL, flags INTEGER NOT NULL, is_archived INTEGER NOT NULL , audience_type INTEGER NOT NULL DEFAULT 0, stanza_xml BLOB, received_timestamp LONG_INT, batch_state INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE status_text( status_row_id INTEGER PRIMARY KEY, url TEXT, page_title TEXT, page_description TEXT, font_style INTEGER, text_color INTEGER, background_color INTEGER, preview_type INTEGER, invite_link_group_type INTEGER, thumbnail BLOB, text_content_proto BLOB );
      CREATE TABLE status_media_link( row_id INTEGER PRIMARY KEY AUTOINCREMENT, status_row_id INTEGER NOT NULL, media_content_row_id INTEGER NOT NULL );
      CREATE TABLE media_content( row_id INTEGER PRIMARY KEY AUTOINCREMENT, state INTEGER NOT NULL, transcoded INTEGER NOT NULL, file_path TEXT, suspicious_content INTEGER NOT NULL, width INTEGER, height INTEGER, file_size INTEGER, file_length INTEGER, media_duration INTEGER, media_key BLOB, media_key_timestamp LONG_INT, partial_media_hash TEXT, partial_media_enc_hash TEXT, file_hash TEXT, enc_file_hash TEXT, direct_path TEXT, static_url TEXT, sidecar BLOB, chunk_lengths BLOB, auto_upload_download INTEGER NOT NULL, media_job_uuid TEXT, mime_type TEXT, gif_attribution INTEGER NOT NULL, trim_from INTEGER, trim_to INTEGER, mute_video INTEGER DEFAULT 0, accessibility_label TEXT, media_transcode_quality INTEGER NOT NULL DEFAULT 0, multicast_id TEXT, media_url TEXT, media_name TEXT, original_file_hash TEXT, media_source_type INTEGER, doodle_id TEXT , media_upload_handle TEXT, smart_thumbnail_ts INTEGER);
    `,
  },
  stickers: {
    file: 'Sticker.sqlite',
    schema: `
      CREATE TABLE ZWACDABSTRACTSTICKERPACK ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILESIZE INTEGER, ZORDER INTEGER, ZSTICKERCOUNT INTEGER, ZFLAGS INTEGER, ZTRAYFILELENGTH INTEGER, ZFLAGS1 INTEGER, ZPREMIUMSTICKERCOUNT INTEGER, ZDOWNLOADEDSTICKERPACK INTEGER, ZTRAYMEDIAKEYTIMESTAMP TIMESTAMP, ZIMAGEDATAHASH VARCHAR, ZNAME VARCHAR, ZPACKDESCRIPTION VARCHAR, ZPUBLISHER VARCHAR, ZSTICKERPACKID VARCHAR, ZTRAYIMAGEID VARCHAR, ZTRAYDIRECTPATH VARCHAR, ZTRAYENCFILEHASH VARCHAR, ZTRAYFILEHASH VARCHAR, ZTRAYIMAGEFILEPATH VARCHAR, ZTRAYMIMETYPE VARCHAR, ZTRAYURL VARCHAR, ZPREVIEWIMAGEIDS BLOB, ZTRAYMEDIAKEY BLOB );
      CREATE TABLE ZWACDSTICKER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILELENGTH INTEGER, ZFLAGS INTEGER, ZHEIGHT INTEGER, ZSORT INTEGER, ZWIDTH INTEGER, ZSTICKERPACK INTEGER, ZMEDIAKEYTIMESTAMP TIMESTAMP, ZACCESSIBILITYTEXT VARCHAR, ZDIRECTPATH VARCHAR, ZEMOJIS VARCHAR, ZENCFILEHASH VARCHAR, ZFILEHASH VARCHAR, ZIMAGEHASH VARCHAR, ZMIMETYPE VARCHAR, ZRELATIVEIMAGEPATH VARCHAR, ZSALTEDFILEHASH VARCHAR, ZSOCIALFBIDSLIST VARCHAR, ZTEMPLATEID VARCHAR, ZURL VARCHAR, ZMEDIAKEY BLOB );
      CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
      INSERT INTO Z_PRIMARYKEY VALUES (1, 'WACDAbstractStickerPack', 0, 0), (2, 'WACDStickerPack', 1, 0), (3, 'WACDStoreStickerPack', 1, 0), (4, 'WACDSticker', 0, 0);
    `,
  },
  localKeyValue: {
    file: 'LocalKeyValue.sqlite',
    schema: `
      CREATE TABLE ZWAKEYVALUEELEMENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZVERSION INTEGER, ZDATE TIMESTAMP, ZKEY VARCHAR, ZNAMESPACE VARCHAR, ZVALUE BLOB );
    `,
  },
  backedUpKeyValue: {
    file: 'BackedUpKeyValue.sqlite',
    schema: `
      CREATE TABLE ZWAKEYVALUEELEMENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZVERSION INTEGER, ZDATE TIMESTAMP, ZKEY VARCHAR, ZNAMESPACE VARCHAR, ZVALUE BLOB );
    `,
  },
} as const;
type Store = keyof typeof stores;
const allStores = Object.keys(stores).filter(
  (store): store is Store => store in stores,
);

// The streams each store feeds, as a store that cannot be read fails them.
const streamsOf: Record<Store, readonly string[]> = {
  chatStorage: [
    'blockedContacts',
    'chatPushConfigs',
    'chats',
    'groupMembers',
    'groupMembersChanges',
    'messageDataItems',
    'messageReactionCounts',
    'messageReactions',
    'messageReceipts',
    'messages',
    'profilePictures',
    'pushNames',
  ],
  contacts: ['contacts'],
  users: ['users'],
  calls: ['callParticipants', 'calls'],
  messageAssociations: ['messageAssociations'],
  businesses: [
    'businessBotPrompts',
    'businessCategories',
    'businessHours',
    'businessProfiles',
    'businessServiceAreas',
    'businessVerifiedNames',
  ],
  statuses: ['statuses'],
  stickers: ['stickerPacks', 'stickers'],
  localKeyValue: [
    'changedNumbers',
    'disappearingModes',
    'linkedProfiles',
    'privacySettings',
  ],
  backedUpKeyValue: ['favoriteStickers', 'recentStickers'],
};

// A synthetic WhatsApp group container: every store, created empty.
class ScratchWhatsApp {
  readonly container: string;

  constructor(container: string) {
    this.container = container;
    for (const store of allStores) this.create(store);
  }

  path(store: Store): string {
    return join(this.container, stores[store].file);
  }

  create(store: Store): void {
    mkdirSync(dirname(this.path(store)), { recursive: true });
    using database = new DatabaseSync(this.path(store));
    database.exec(`PRAGMA journal_mode = WAL; ${stores[store].schema}`);
    if (store === 'chatStorage')
      database
        .prepare('INSERT INTO Z_METADATA (Z_VERSION, Z_UUID) VALUES (1, ?)')
        .run(randomUUID());
  }

  insert(
    store: Store,
    table: string,
    row: Record<string, SQLInputValue>,
  ): void {
    using database = new DatabaseSync(this.path(store));
    const columns = Object.keys(row);
    database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...Object.values(row));
  }

  exec(store: Store, sql: string): void {
    using database = new DatabaseSync(this.path(store));
    database.exec(sql);
  }

  // A file WhatsApp keeps in its container, such as downloaded media.
  file(relative: string, content: string): void {
    const path = join(this.container, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

// Core Data stores a date as seconds since 2001-01-01 UTC in a double.
const coreData = (iso: string, micros = 0) =>
  Date.parse(iso) / 1000 - 978307200 + micros / 1e6;
const unixSeconds = (iso: string) => Date.parse(iso) / 1000;

// A protobuf as WhatsApp writes it: fields by number, nested messages,
// floats as fixed 32-bit fields.
type ProtobufValue =
  | number
  | bigint
  | string
  | Uint8Array
  | { readonly float: number }
  | { readonly message: ProtobufFields };
type ProtobufFields = readonly (readonly [number, ProtobufValue])[];

function protobuf(fields: ProtobufFields): Uint8Array {
  const bytes: number[] = [];
  const varint = (value: bigint) => {
    let rest = value;
    do {
      const low = Number(rest & 0x7fn);
      rest >>= 7n;
      bytes.push(rest === 0n ? low : low | 0x80);
    } while (rest !== 0n);
  };
  for (const [number, value] of fields) {
    if (typeof value === 'number' || typeof value === 'bigint') {
      varint(BigInt(number << 3));
      varint(BigInt(value));
    } else if (typeof value === 'object' && 'float' in value) {
      varint(BigInt((number << 3) | 5));
      const float = new Uint8Array(4);
      new DataView(float.buffer).setFloat32(0, value.float, true);
      bytes.push(...float);
    } else {
      const content =
        typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : protobuf(value.message);
      varint(BigInt((number << 3) | 2));
      varint(BigInt(content.length));
      bytes.push(...content);
    }
  }
  return Uint8Array.from(bytes);
}

// A receipt's recipient as WhatsApp packs it: the server's byte, then the
// user part in binary-coded decimal padded with an F nibble.
function packedJid(server: number, user: string): Uint8Array {
  const digits = user.length % 2 === 0 ? user : `${user}f`;
  return Uint8Array.from([server, ...Buffer.from(digits, 'hex')]);
}

class Uid {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}
type PlistInput =
  | string
  | number
  | Uid
  | Uint8Array
  | PlistInput[]
  | { [key: string]: PlistInput };

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function plistXml(value: PlistInput): string {
  if (typeof value === 'string') return `<string>${escape(value)}</string>`;
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (value instanceof Uid)
    return `<dict><key>CF$UID</key><integer>${value.value}</integer></dict>`;
  if (value instanceof Uint8Array)
    return `<data>${Buffer.from(value).toString('base64')}</data>`;
  if (Array.isArray(value))
    return `<array>${value.map(plistXml).join('')}</array>`;
  return `<dict>${Object.entries(value)
    .map(([key, field]) => `<key>${escape(key)}</key>${plistXml(field)}`)
    .join('')}</dict>`;
}

// An NSKeyedArchiver archive with the given root object, the objects it
// refers to after it, as Foundation writes it.
function keyedArchive(objects: readonly PlistInput[]): Uint8Array {
  return execFileSync(
    '/usr/bin/plutil',
    ['-convert', 'binary1', '-o', '-', '-'],
    {
      input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${plistXml(
        {
          $version: 100000,
          $archiver: 'NSKeyedArchiver',
          $top: { root: new Uid(1) },
          $objects: ['$null', ...objects],
        },
      )}</plist>`,
    },
  );
}

const nsClass = (name: string, ...supers: string[]) => ({
  $classname: name,
  $classes: [name, ...supers, 'NSObject'],
});

// An NSArray of strings: the array, its strings, then its class.
function archivedStrings(strings: readonly string[]): Uint8Array {
  return keyedArchive([
    {
      'NS.objects': strings.map((_, index) => new Uid(2 + index)),
      $class: new Uid(2 + strings.length),
    },
    ...strings,
    nsClass('NSArray'),
  ]);
}

// A GPBMessage subclass as WhatsApp archives one: its bytes under GPBData.
function archivedProtobuf(className: string, bytes: Uint8Array): Uint8Array {
  return keyedArchive([
    { GPBData: new Uid(2), $class: new Uid(3) },
    bytes,
    nsClass(className, 'GPBMessage'),
  ]);
}

type Hours = {
  day: number;
  mode: number;
  openTime: number;
  closeTime: number;
};

// An NSArray of WABizHoursConfig, as ZHOURSCONFIGS holds it.
function archivedHours(days: readonly Hours[]): Uint8Array {
  const configClass = 2 + days.length + 1;
  return keyedArchive([
    {
      'NS.objects': days.map((_, index) => new Uid(2 + index)),
      $class: new Uid(2 + days.length),
    },
    ...days.map((day) => ({ ...day, $class: new Uid(configClass) })),
    nsClass('NSArray'),
    nsClass('WABizHoursConfig'),
  ]);
}

const alice = '15550001001@s.whatsapp.net';
const aliceLid = '9001@lid';
const bobLid = '9002@lid';
const group = '120363000000000001@g.us';
const channel = '120363000000000002@newsletter';

// One small WhatsApp history in every store: a person, a group, a channel
// and each other kind of chat; messages of several kinds with their media,
// receipts and reactions; and the people, calls, businesses, stickers and
// settings WhatsApp keeps beside them.
function whatsappFixture(whatsapp: ScratchWhatsApp): void {
  const sent = Date.parse('2026-10-01T10:00:00.000Z') / 1000;
  whatsapp.exec(
    'chatStorage',
    `
    INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, ZCONTACTJID, ZSESSIONTYPE, ZPARTNERNAME, ZCONTACTIDENTIFIER, ZCONTACTABID, ZARCHIVED, ZHIDDEN, ZREMOVED, ZFLAGS, ZUNREADCOUNT, ZMESSAGECOUNTER, ZIDENTITYVERIFICATIONSTATE, ZIDENTITYVERIFICATIONEPOCH, ZLASTMESSAGEDATE, ZLASTMESSAGETEXT, ZSAVEDINPUT, ZSPOTLIGHTSTATUS, ZETAG)
      VALUES (1, 4, '${alice}', 0, 'Alice', 'A1B2:ABPerson', 42, 0, 0, 0, 256, 1, 9, 0, 1, ${coreData('2026-10-01T10:00:00.000Z')}, 'agJCMQ==', 'see you', 3, 'etag');
    INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, ZCONTACTJID, ZSESSIONTYPE, ZPARTNERNAME, ZGROUPINFO, ZARCHIVED, ZUNREADCOUNT)
      VALUES (2, 4, '${group}', 1, 'Trip', 1, 1, 0),
             (3, 4, '${channel}', 5, 'News', NULL, 0, 0),
             (4, 4, '1700000000@broadcast', 2, NULL, NULL, 0, 0),
             (5, 4, '9001@lid.status', 3, NULL, NULL, 0, 0),
             (6, 4, '120363000000000003@g.us', 4, 'Neighbours', NULL, 0, 0),
             (7, 4, '${alice}', 0, 'Alice, again', NULL, 0, 0);
    INSERT INTO ZWAGROUPINFO (Z_PK, Z_ENT, ZCHATSESSION, ZCREATIONDATE, ZCREATORJID, ZOWNERJID, ZSUBJECTTIMESTAMP, ZSUBJECTOWNERJID, ZPICTUREID, ZPICTUREPATH, ZSOURCEJID, ZSTATE)
      VALUES (1, 5, 2, ${coreData('2025-01-01T00:00:00.000Z')}, '${bobLid}', '${bobLid}', ${coreData('2025-02-01T00:00:00.000Z')}, '${aliceLid}', 'G-PIC', 'Media/Profile/group', NULL, 0);
    INSERT INTO ZWAGROUPMEMBER (Z_PK, Z_ENT, ZCHATSESSION, ZMEMBERJID, ZCONTACTNAME, ZFIRSTNAME, ZCONTACTIDENTIFIER, ZCONTACTABID, ZISACTIVE, ZISADMIN, ZSENDERKEYSENT)
      VALUES (1, 6, 2, '${bobLid}', 'Bob', 'Bob', NULL, NULL, 1, 1, 1),
             (2, 6, 2, '${aliceLid}', 'Alice', 'Alice', 'A1B2:ABPerson', 42, 0, 0, 0),
             (3, 6, 6, '9003@lid', 'Carol', NULL, NULL, NULL, 1, 0, 0);
    INSERT INTO ZWAGROUPMEMBERSCHANGE (Z_PK, Z_ENT, ZGROUPJID, ZCHANGEDATE, ZCHANGETYPE, ZMEMBERJIDS, ZPHASHBEFORECHANGE)
      VALUES (1, 7, '${group}', ${coreData('2026-09-01T08:00:00.000Z')}, 4, '${aliceLid}', '2:abc');
    INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, Z_ENT, ZJID, ZPUSHNAME) VALUES (1, 13, '${bobLid}', 'Bobby');
    INSERT INTO ZWAPROFILEPICTUREITEM (Z_PK, Z_ENT, ZJID, ZPICTUREID, ZPATH, ZREQUESTDATE)
      VALUES (1, 12, '${aliceLid}', 'P-1', 'Media/Profile/9001-1', ${coreData('2026-09-02T00:00:00.000Z')}),
             (2, 12, '${bobLid}', 'P-2', 'Media/Profile/9002-1', NULL);
    INSERT INTO ZWABLACKLISTITEM (Z_PK, Z_ENT, ZJID) VALUES (1, 1, '15550006666@s.whatsapp.net');
    INSERT INTO ZWACHATPUSHCONFIG (Z_PK, Z_ENT, ZJID, ZALERTS, ZMUTEDUNTIL, ZSOUND, ZRINGTONE)
      VALUES (1, 3, '${alice}', 0, 63113904000, 'note', NULL),
             (2, 3, '15550009999@s.whatsapp.net', 1, NULL, NULL, 'ring');
    `,
  );
  whatsapp.file('Media/Profile/9001-1.thumb', 'alice thumbnail');
  const message = (row: Record<string, SQLInputValue>) =>
    whatsapp.insert('chatStorage', 'ZWAMESSAGE', {
      Z_ENT: 9,
      ZGROUPEVENTTYPE: 2,
      ZDOCID: 7,
      ZSPOTLIGHTSTATUS: 1,
      ZENCRETRYCOUNT: 0,
      ZPHASH: 'phash',
      ...row,
    });
  const media = (row: Record<string, SQLInputValue>) =>
    whatsapp.insert('chatStorage', 'ZWAMEDIAITEM', {
      Z_ENT: 8,
      ZMEDIAKEY: Uint8Array.from([1, 2, 3]),
      ZXMPPTHUMBPATH: 'device list',
      ...row,
    });
  // Alice asks; this account replies quoting her, and she reads it.
  media({ Z_PK: 1, ZMESSAGE: 1 });
  message({
    Z_PK: 1,
    ZCHATSESSION: 1,
    ZISFROMME: 0,
    ZSTANZAID: 'A1',
    ZFROMJID: alice,
    ZPUSHNAME: 'Alice',
    ZMESSAGEDATE: coreData('2026-10-01T09:00:00.000Z', 250123),
    ZMESSAGETYPE: 0,
    ZMESSAGESTATUS: 6,
    ZFLAGS: 16777216,
    ZSTARRED: 1,
    ZSORT: 1,
    ZTEXT: 'Are you coming?',
    ZMEDIAITEM: 1,
  });
  media({
    Z_PK: 2,
    ZMESSAGE: 2,
    ZMETADATA: protobuf([
      [5, 'A1'],
      [6, aliceLid],
      [68, new Uint8Array(32)],
    ]),
  });
  whatsapp.insert('chatStorage', 'ZWAMESSAGEINFO', {
    Z_PK: 1,
    Z_ENT: 11,
    ZMESSAGE: 2,
    ZRECEIPTINFO: protobuf([
      [
        2,
        {
          message: [
            [1, packedJid(0x8c, '9001')],
            [4, 2],
            [5, 30],
            [6, 90],
            [10, { message: [[1, 0]] }],
          ],
        },
      ],
      [
        2,
        {
          message: [
            [1, packedJid(0x81, '15550001001')],
            [4, 0],
          ],
        },
      ],
      [2, { message: [[1, packedJid(0x83, '1313')]] }],
      [3, sent],
      [4, 2],
      [
        7,
        {
          message: [
            [
              1,
              {
                message: [
                  [1, 'R1'],
                  [3, '👍'],
                  [4, sent * 1000 + 5123],
                  [5, 1],
                  [6, 1],
                ],
              },
            ],
            [
              1,
              {
                message: [
                  [1, 'R2'],
                  [2, aliceLid],
                  [4, sent * 1000 + 9000],
                  [5, 0],
                ],
              },
            ],
          ],
        },
      ],
    ]),
  });
  message({
    Z_PK: 2,
    ZCHATSESSION: 1,
    ZISFROMME: 1,
    ZSTANZAID: 'B1',
    ZTOJID: alice,
    ZMESSAGEDATE: coreData('2026-10-01T10:00:00.000Z'),
    ZSENTDATE: coreData('2026-10-01T10:00:01.000Z'),
    ZMESSAGETYPE: 0,
    ZMESSAGESTATUS: 8,
    ZTEXT: 'Yes',
    ZMEDIAITEM: 2,
    ZMESSAGEINFO: 1,
  });
  // A document Alice sent that was never downloaded to this Mac.
  media({
    Z_PK: 3,
    ZMESSAGE: 3,
    ZMEDIALOCALPATH: 'Media/15550001001@s.whatsapp.net/0/1/plan.pdf',
    ZMEDIAURL: 'https://mmg.whatsapp.net/plan',
    ZFILESIZE: 2048,
    ZAUTHORNAME: 'plan.pdf',
    ZVCARDSTRING: 'application/pdf',
    ZVCARDNAME: 'aGFzaA==',
  });
  message({
    Z_PK: 3,
    ZCHATSESSION: 1,
    ZISFROMME: 0,
    ZSTANZAID: 'A2',
    ZFROMJID: alice,
    ZMESSAGEDATE: coreData('2026-10-02T09:00:00.000Z'),
    ZMESSAGETYPE: 8,
    ZMESSAGESTATUS: 6,
    ZTEXT: 'The plan',
    ZMEDIAITEM: 3,
  });
  // Bob's photo in the group, downloaded, which WhatsApp stores twice.
  whatsapp.file('Message/Media/120363000000000001@g.us/a/b/photo.jpg', 'jpeg');
  for (const [pk, sort] of [
    [4, 4],
    [5, 40],
  ] as const) {
    media({
      Z_PK: pk,
      ZMESSAGE: pk,
      ZMEDIALOCALPATH: 'Media/120363000000000001@g.us/a/b/photo.jpg',
      ZTHUMBNAILLOCALPATH: 'Media/120363000000000001@g.us/a/b/photo.thumb',
      ZMEDIAURL: 'https://mmg.whatsapp.net/photo',
      ZMEDIAURLDATE: coreData('2026-10-03T08:00:00.000Z'),
      ZFILESIZE: 4,
      ZASPECTRATIO: 1.5,
      ZTITLE: 'At the lake',
      ZVCARDNAME: 'cGhvdG8=',
      ZVCARDSTRING: 'image/jpeg',
      ZLATITUDE: 900,
      ZLONGITUDE: 1600,
      ZMEDIAORIGIN: 0,
      ZCLOUDSTATUS: 64,
    });
    message({
      Z_PK: pk,
      ZCHATSESSION: 2,
      ZISFROMME: 0,
      ZSTANZAID: 'G1',
      ZFROMJID: group,
      ZGROUPMEMBER: 1,
      ZPUSHNAME: 'Bobby',
      ZMESSAGEDATE: coreData('2026-10-03T08:00:00.000Z'),
      ZMESSAGETYPE: 1,
      ZMESSAGESTATUS: 6,
      ZSORT: sort,
      ZMEDIAITEM: pk,
    });
  }
  // A group notice, from no member; and this account's link, part of
  // nothing, with the link WhatsApp found in it.
  message({
    Z_PK: 6,
    ZCHATSESSION: 2,
    ZISFROMME: 0,
    ZSTANZAID: 'G2',
    ZFROMJID: group,
    ZMESSAGEDATE: coreData('2026-10-03T09:00:00.000Z'),
    ZMESSAGETYPE: 6,
    ZGROUPEVENTTYPE: 38,
    ZTEXT: 'Bob changed the subject',
  });
  media({
    Z_PK: 7,
    ZMESSAGE: 7,
    ZMEDIAURL: 'https://example.com',
    ZTITLE: 'Example',
  });
  message({
    Z_PK: 7,
    ZCHATSESSION: 2,
    ZISFROMME: 1,
    ZSTANZAID: 'G3',
    ZTOJID: group,
    ZMESSAGEDATE: coreData('2026-10-04T09:00:00.000Z'),
    ZMESSAGETYPE: 7,
    ZTEXT: 'Look https://example.com',
    ZPARENTMESSAGE: 4,
    ZMEDIAITEM: 7,
  });
  whatsapp.insert('chatStorage', 'ZWAMESSAGEDATAITEM', {
    Z_PK: 1,
    Z_ENT: 10,
    ZMESSAGE: 7,
    ZINDEX: 0,
    ZTYPE: 0,
    ZDATE: coreData('2026-10-04T09:00:00.000Z'),
    ZCHATJID: 'p2',
    ZCONTENT1: 'https://example.com',
    ZTITLE: 'Example',
    ZSUMMARY: 'An example page',
    ZMATCHEDTEXT: 'https://example.com',
    ZSECTIONID: '2026-10',
  });
  // A channel post, whose reactions WhatsApp counts.
  whatsapp.insert('chatStorage', 'ZWAMESSAGEINFO', {
    Z_PK: 2,
    Z_ENT: 11,
    ZMESSAGE: 8,
    ZRECEIPTINFO: protobuf([
      [
        7,
        {
          message: [
            [
              3,
              {
                message: [
                  [
                    1,
                    {
                      message: [
                        [1, '❤️'],
                        [2, 10],
                      ],
                    },
                  ],
                  [
                    1,
                    {
                      message: [
                        [1, '😂'],
                        [2, 1],
                      ],
                    },
                  ],
                ],
              },
            ],
          ],
        },
      ],
    ]),
  });
  message({
    Z_PK: 8,
    ZCHATSESSION: 3,
    ZISFROMME: 0,
    ZSTANZAID: 'N1',
    ZFROMJID: channel,
    ZMESSAGEDATE: coreData('2026-10-05T09:00:00.000Z'),
    ZMESSAGETYPE: 0,
    ZTEXT: 'Headline',
    ZMESSAGEINFO: 2,
  });
  // A notice WhatsApp keeps after removing its chat.
  message({
    Z_PK: 9,
    ZCHATSESSION: null,
    ZISFROMME: 0,
    ZSTANZAID: 'X1',
    ZFROMJID: aliceLid,
    ZMESSAGEDATE: coreData('2026-10-05T10:00:00.000Z'),
    ZMESSAGETYPE: 28,
  });
  whatsapp.insert('messageAssociations', 'message_parent_association', {
    stanza_id: 'G3',
    parent_stanza_id: 'G1',
    type: 1,
    sort: 5,
    chat_jid: group,
  });

  whatsapp.insert('contacts', 'ZWAADDRESSBOOKCONTACT', {
    Z_PK: 1,
    Z_ENT: 1,
    ZUNIQUEID: '0A1B2C3D-0000-4000-8000-000000000001',
    ZWHATSAPPID: alice,
    ZLID: aliceLid,
    ZIDENTIFIER: 'A1B2:ABPerson',
    ZFULLNAME: 'Alice Smith',
    ZGIVENNAME: 'Alice',
    ZLASTNAME: 'Smith',
    ZHIGHLIGHTEDNAME: 'Alice',
    ZPHONENUMBER: '15550001001',
    ZLOCALIZEDPHONENUMBER: '+1 555-000-1001',
    ZPHONENUMBERLABEL: 'mobile',
    ZPHONESTATUS: 1,
    ZABOUTTEXT: 'Busy',
    ZABOUTTIMESTAMP: coreData('2026-01-01T00:00:00.000Z'),
    ZDISAPPEARINGMODEDURATION: 0,
    ZSOURCE: 1,
    ZSYNCPOLICY: 1,
    ZLASTUPDATED: coreData('2026-10-01T00:00:00.000Z'),
    ZSORT: 3,
    ZSECTIONTITLE: 'A',
    ZSEARCHTOKENLIST: 'alice smith',
    ZDEVICELIST: Uint8Array.from([9, 9]),
  });
  // Foundation's distant past, where WhatsApp has no date.
  whatsapp.exec(
    'users',
    `
    INSERT INTO ZWAZACCOUNT (Z_PK, Z_ENT, ZIDENTIFIER, ZPHONENUMBER, ZCOUNTRYCODE, ZDISPLAYNAME, ZUSERNAME, ZUSERTYPE, ZSTATE, ZCURRENTPHONENUMBERSHARINGSTATE, ZUSERNAMESTATE, ZCREATEDAT)
      VALUES (1, 5, '${aliceLid}', '15550001001', 'US', 'Alice', NULL, 0, 1, 1, NULL, ${coreData('2026-03-01T00:00:00.000Z')}),
             (2, 5, '${bobLid}', NULL, NULL, 'Bob', 'bob', 0, 1, 0, 0, -63114076800);
    `,
  );
  // Call-log entries whose numbers differ from their calls', so a join on
  // the wrong row number finds nothing: a video call with Alice, and a
  // missed group call with two others.
  whatsapp.exec(
    'calls',
    `
    INSERT INTO ZWAAGGREGATECALLEVENT (Z_PK, Z_ENT, ZINCOMING, ZMISSED, ZMISSEDREASON, ZVIDEO, ZFIRSTDATE, ZLINKTOKEN)
      VALUES (1, 1, 0, 0, 1, 1, ${coreData('2026-09-10T18:00:00.000Z')}, ''),
             (2, 1, 1, 1, 1, 0, ${coreData('2026-09-11T18:00:00.000Z')}, '');
    INSERT INTO ZWACDCALLEVENT (Z_PK, Z_ENT, Z1CALLEVENTS, Z_FOK_1CALLEVENTS, ZCALLIDSTRING, ZDATE, ZDURATION, ZOUTCOME, ZBYTESSENT, ZBYTESRECEIVED, ZGROUPJIDSTRING, ZGROUPCALLCREATORUSERJIDSTRING, ZISBOTGROUPCALL, ZISLIGHTWEIGHT, ZSCHEDULEDID)
      VALUES (10, 2, 1, 1024, 'CALL-VIDEO', ${coreData('2026-09-10T18:00:00.000Z')}, 125.5, 0, 1000, 2000, NULL, NULL, 0, 0, ''),
             (11, 2, 2, 1024, 'CALL-GROUP', ${coreData('2026-09-11T18:00:00.000Z')}, 0, 1, 0, 0, '${group}', '${bobLid}', 0, 0, '');
    INSERT INTO ZWACDCALLEVENTPARTICIPANT (Z_PK, Z_ENT, Z1PARTICIPANTS, Z_FOK_1PARTICIPANTS, ZJIDSTRING, ZOUTCOME)
      VALUES (1, 3, 1, 1024, '${alice}', 0),
             (2, 3, 2, 1024, '${aliceLid}', 1),
             (3, 3, 2, 2048, '${bobLid}', 4);
    `,
  );

  const shop = '15550007777@s.whatsapp.net';
  whatsapp.insert('businesses', 'ZWABIZPROFILEDATA', {
    Z_PK: 1,
    Z_ENT: 16,
    ZJID: shop,
    ZTAG: 12345,
    ZFLAGS: 1,
    ZBUSINESSDESCRIPTION: 'Fresh bread',
    ZADDRESS: '1 Main St',
    ZLATITUDE: 31.95,
    ZLONGITUDE: 35.91,
    ZEMAIL: 'shop@example.com',
    ZWEBSITES: archivedStrings(['https://a.example', 'https://b.example']),
    ZHOURSCONFIGS: archivedHours([
      { day: 2, mode: 1, openTime: 540, closeTime: 1020 },
      { day: 2, mode: 1, openTime: 540, closeTime: 1020 },
      { day: 3, mode: 1, openTime: 600, closeTime: 1080 },
    ]),
    ZTIMEZONE: 'Asia/Amman',
    ZMEMBERSINCEDATE: coreData('2020-05-01T00:00:00.000Z'),
    ZMEMBERSINCETEXT: 'Joined in May, 2020',
    ZLINKEDACCOUNTS: archivedProtobuf(
      'WAPBBizProfileLinkedAccounts',
      protobuf([
        [
          1,
          {
            message: [
              [1, '100200300400500'],
              [2, 'Shop Page'],
              [3, 120],
            ],
          },
        ],
        [
          2,
          {
            message: [
              [1, 'shop.gram'],
              [2, 300],
            ],
          },
        ],
      ]),
    ),
    ZPROFILEOPTIONS: 1,
    ZBOTDATA: 1,
    ZCOVERPHOTO: 1,
  });
  whatsapp.exec(
    'businesses',
    `
    INSERT INTO ZWABIZPROFILEOPTIONSDATA (Z_PK, Z_ENT, ZPROFILE, ZCOMMERCEEXPERIENCE, ZCARTENABLED, ZSHOPURL, ZISVIDEOCALLINGENABLED, ZFLAGS)
      VALUES (1, 17, 1, 'catalog', 1, 'https://shop.example', 0, 64);
    INSERT INTO ZWABIZBOTDATA (Z_PK, Z_ENT, ZPROFILE, ZAUTOMATEDTYPE) VALUES (1, 3, 1, '1p_partial');
    INSERT INTO ZWABIZCOVERPHOTODATA (Z_PK, Z_ENT, ZPROFILE, ZIMAGEID, ZURL) VALUES (1, 6, 1, '1234567890123456', 'https://media.example/cover');
    INSERT INTO ZWABIZCATEGORYDATA (Z_PK, Z_ENT, ZPROFILE, Z_FOK_PROFILE, ZCATEGORYID, ZNAME)
      VALUES (1, 5, 1, 3072, '2250', 'Grocery Store'),
             (2, 5, 1, 2048, '1600', 'Bakery');
    INSERT INTO ZWABIZSERVICEAREADATA (Z_PK, Z_ENT, ZPROFILE, ZLATITUDE, ZLONGITUDE, ZAREARADIUSMETERS, ZAREADESCRIPTION)
      VALUES (1, 19, 1, 31.9, 35.9, 1000, 'Downtown');
    INSERT INTO ZWABIZBOTPROMPTDATA (Z_PK, Z_ENT, ZBOTDATA, Z_FOK_BOTDATA, ZTEXT, ZEMOJI)
      VALUES (1, 4, 1, 2048, 'Is it open?', NULL),
             (2, 4, 1, 1024, 'What is fresh?', '🥖');
    INSERT INTO ZWABIZROLEDATA (Z_PK, Z_ENT, ZJID, ZACTOR, ZHOSTSTORAGE, ZLASTUPDATETIME)
      VALUES (1, 18, '7777@lid', 2, 2, ${unixSeconds('2026-09-14T12:00:00.000Z')});
    `,
  );
  whatsapp.insert('businesses', 'ZWABIZVERIFIEDNAMEDATA', {
    Z_PK: 1,
    Z_ENT: 21,
    ZJID: '7777@lid',
    ZPHONENUMBERJID: shop,
    ZNAME: 'The Shop',
    ZVERIFICATIONLEVEL: 3,
    // A serial past 2^53, which a JavaScript number would round.
    ZCERTIFICATEDETAILS: archivedProtobuf(
      'WAPBVerifiedNameCertificate_Details',
      protobuf([
        [1, 9007199254740993n],
        [2, 'ent:wa'],
        [4, 'The Shop'],
        [10, unixSeconds('2018-07-13T00:00:00.000Z')],
      ]),
    ),
  });
  whatsapp.insert('businesses', 'ZWABIZVERIFIEDNAMEDATA', {
    Z_PK: 2,
    Z_ENT: 21,
    ZJID: '8888@lid',
    ZNAME: 'No Profile',
    ZVERIFICATIONLEVEL: 1,
    ZCERTIFICATEDETAILS: archivedProtobuf(
      'WAPBVerifiedNameCertificate_Details',
      protobuf([
        [1, 5],
        [2, 'smb:wa'],
      ]),
    ),
  });

  // A pack in the tray with one sticker on disk, the store's listing of it
  // and of another pack, a favorite that belongs to no pack, and a recent
  // sticker WhatsApp keeps no file of.
  whatsapp.exec(
    'stickers',
    `
    INSERT INTO ZWACDABSTRACTSTICKERPACK (Z_PK, Z_ENT, ZSTICKERPACKID, ZNAME, ZPUBLISHER, ZPACKDESCRIPTION, ZFILESIZE, ZSTICKERCOUNT, ZORDER, ZFLAGS, ZFLAGS1, ZIMAGEDATAHASH, ZTRAYIMAGEID, ZTRAYIMAGEFILEPATH)
      VALUES (1, 2, 'cuppy', 'Cuppy', 'WhatsApp', 'A cup', 1000, 25, 0, 1, NULL, 'IMGHASH', 'TRAY1', 'packdir/tray.png'),
             (2, 3, 'cuppy', 'Cuppy', 'WhatsApp', 'A cup', 1000, 25, 4, NULL, 2, 'IMGHASH', 'TRAY1', NULL);
    INSERT INTO ZWACDSTICKER (Z_PK, Z_ENT, ZSTICKERPACK, ZFILEHASH, ZSORT, ZMIMETYPE, ZWIDTH, ZHEIGHT, ZFILELENGTH, ZFLAGS, ZEMOJIS, ZACCESSIBILITYTEXT, ZIMAGEHASH, ZRELATIVEIMAGEPATH, ZMEDIAKEY, ZENCFILEHASH, ZDIRECTPATH, ZURL, ZSALTEDFILEHASH)
      VALUES (1, 4, 1, 'HASH1', 0, 'image/webp', 512, 512, 100, 128, '☕ 😀', 'A happy cup', 'IMG1', 'packdir/one.webp', x'0102', 'ENC', '/d', 'https://mmg.example', 'salted'),
             (2, 4, NULL, 'HASH2', 0, 'image/webp', 0, 0, 200, 1, NULL, NULL, 'IMG2', 'no-sticker-pack/two.webp', NULL, NULL, NULL, NULL, NULL),
             (3, 4, NULL, 'HASH3', 0, 'application/was', 0, 0, 300, 0, NULL, NULL, 'IMG3', NULL, NULL, NULL, NULL, NULL, NULL);
    `,
  );
  whatsapp.insert('stickers', 'ZWACDABSTRACTSTICKERPACK', {
    Z_PK: 3,
    Z_ENT: 3,
    ZSTICKERPACKID: 'flump',
    ZNAME: 'Flump',
    ZORDER: 5,
    ZFLAGS1: 7,
    ZPREVIEWIMAGEIDS: archivedStrings(['PREVIEW1', 'PREVIEW2']),
  });
  whatsapp.file('stickers/packdir/one.webp', 'sticker one');
  whatsapp.file('stickers/no-sticker-pack/two.webp', 'sticker two');

  const keyValue = (
    store: 'localKeyValue' | 'backedUpKeyValue',
    namespace: string,
    key: string,
    value: Uint8Array | string,
    date = coreData('2026-10-10T08:31:34.000Z'),
  ) =>
    whatsapp.insert(store, 'ZWAKEYVALUEELEMENT', {
      Z_ENT: 1,
      ZVERSION: 0,
      ZNAMESPACE: namespace,
      ZKEY: key,
      ZVALUE:
        typeof value === 'string' ? new TextEncoder().encode(value) : value,
      ZDATE: date,
    });
  keyValue('localKeyValue', 'privacy-settings-values', 'last', 'none');
  keyValue('localKeyValue', 'privacy-settings-values', 'groupadd', 'contacts');
  keyValue(
    'localKeyValue',
    'disappearing-mode',
    aliceLid,
    protobuf([
      [1, 604800],
      [2, unixSeconds('2026-03-13T10:00:00.000Z')],
    ]),
  );
  keyValue(
    'localKeyValue',
    'disappearing-mode',
    bobLid,
    protobuf([
      [1, 0],
      [2, 0],
    ]),
  );
  keyValue(
    'localKeyValue',
    'linked-profiles',
    aliceLid,
    JSON.stringify([
      {
        type: 'INSTAGRAM',
        username: 'alice.s',
        url: 'https://instagram.com/alice.s',
        vid: 'viewer-token',
      },
    ]),
  );
  keyValue(
    'localKeyValue',
    'changenumber-oldtonew',
    '15550001111@s.whatsapp.net',
    '15550002222@s.whatsapp.net',
    coreData('2026-08-01T00:00:00.000Z'),
  );
  keyValue('localKeyValue', 'reporting-token', 'secret', 'not read');
  keyValue(
    'backedUpKeyValue',
    'fs.v2',
    'HASH2',
    Uint8Array.from([1]),
    coreData('2025-04-29T12:00:00.000Z'),
  );
  keyValue(
    'backedUpKeyValue',
    'rs.v2',
    'ordered_regular_recent_stickers_data',
    protobuf([
      [
        1,
        {
          message: [
            [1, 'HASH2'],
            [2, { float: 1.5 }],
            [3, 1791702449217],
          ],
        },
      ],
      [
        1,
        {
          message: [
            [1, 'HASH3'],
            [2, { float: 0.25 }],
            [3, 1],
          ],
        },
      ],
      [2, 1],
    ]),
  );

  // Alice's statuses, posted relative to now since they expire a day later:
  // a photo this Mac downloaded, a text status with a link, and one past its
  // day that WhatsApp still holds.
  whatsapp.file('Message/Media/9001@lid/s/t/status.jpg', 'status photo');
  whatsapp.exec(
    'statuses',
    `
    INSERT INTO status (row_id, sort_id, uuid, sender_user_jid, status_info_row_id, type, timestamp, server_receipt_timestamp, received_timestamp, text_data, state, secret, content_proto, origin, flags, is_archived, audience_type)
      VALUES (1, 1, 'S-PHOTO', '${aliceLid}', 1, 4, ${statusSeconds(hoursAgo(2))}, ${statusSeconds(hoursAgo(2))}, ${statusSeconds(hoursAgo(1))}, 'At the beach', 4, x'00', x'00', 0, 0, 0, 0),
             (2, 2, 'S-TEXT', '${aliceLid}', 1, 10, ${statusSeconds(hoursAgo(22))}, NULL, NULL, 'Read this https://news.example', 4, x'00', NULL, 0, 0, 0, 0),
             (3, 3, 'S-OLD', '${bobLid}', 2, 10, ${statusSeconds(hoursAgo(26))}, NULL, NULL, 'Yesterday', 4, NULL, NULL, 0, 0, 0, 0);
    INSERT INTO status_text (status_row_id, url, page_title, page_description, font_style, text_color, background_color, preview_type)
      VALUES (2, 'https://news.example', 'News', 'Today’s news', 2, -1, -16777216, 1);
    INSERT INTO media_content (row_id, state, transcoded, file_path, suspicious_content, width, height, file_size, media_duration, media_key, file_hash, enc_file_hash, direct_path, auto_upload_download, mime_type, gif_attribution, accessibility_label)
      VALUES (1, 6, 0, 'Media/9001@lid/s/t/status.jpg', 0, 1080, 1920, 12, NULL, x'0102', 'c3RhdHVz', 'ENC', '/v/t', 0, 'image/jpeg', 0, 'A beach');
    INSERT INTO status_media_link (status_row_id, media_content_row_id) VALUES (1, 1);
    `,
  );
  whatsapp.exec(
    'chatStorage',
    `
    UPDATE ZWAMESSAGE SET Z_OPT = 1;
    UPDATE ZWAMEDIAITEM SET Z_OPT = 1;
    UPDATE ZWAMESSAGEINFO SET Z_OPT = 1;
  `,
  );
}

// A time some hours before the tests started, whole seconds as Status.sqlite
// keeps them; one start, so a fixture and its assertions agree.
const started = Math.floor(Date.now() / 1000);
const hoursAgo = (hours: number) => new Date((started - hours * 3600) * 1000);
const statusSeconds = (date: Date) => date.getTime() / 1000 - 978307200;

// The source loaded as the Apple hosts load it: every stream incrementally
// into a table of its name, with the files of the streams that carry them
// kept beside it.
async function pipeline(
  source: WhatsAppDesktopSource,
  directory: string,
  only?: (stream: Stream) => boolean,
) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams
          .filter((stream) => only?.(stream) ?? true)
          .map(
            (stream) =>
              new Copy(
                stream,
                destination.table(
                  stream.name,
                  stream.supportsFileTransfer
                    ? (columns) => [
                        ...SQLiteColumns.fromSchema(stream.jsonSchema),
                        columns
                          .text('attachmentRef')
                          .from(stream.file.store(files)),
                      ]
                    : undefined,
                ),
                {
                  id: stream.name,
                  syncMode: 'incremental',
                  destinationSyncMode: 'append_dedup',
                },
              ),
          ),
      }),
    ],
  });
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// A loaded table as a reader reads it, without the load's own columns.
function table(path: string, name: string, orderBy: string) {
  const columns = rows(path, `SELECT name FROM pragma_table_info('${name}')`)
    .map((column) => String(column.name))
    .filter((column) => column !== 'loaded_at' && !column.startsWith('_elt'))
    .map((column) => `"${column}"`);
  return rows(
    path,
    `SELECT ${columns.join(', ')} FROM "${name}" ORDER BY ${orderBy}`,
  );
}

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

// The streams whose copies failed, and each kind of failure, once.
function failures(error: unknown) {
  assert.ok(error instanceof PipelineError);
  const failed = error.results.filter(({ failures }) => failures.length > 0);
  return {
    streams: failed.map(({ copy }) => copy.from.name).sort(),
    types: [
      ...new Set(
        failed.flatMap(({ failures }) =>
          failures.map(({ failureType }) => failureType),
        ),
      ),
    ].sort(),
    errors: failed.flatMap(({ failures }) =>
      failures.map(({ error }) => error),
    ),
  };
}

async function scratch() {
  const dir = await mkdtempDisposable(join(tmpdir(), 'elt-whatsapp-'));
  const whatsapp = new ScratchWhatsApp(join(dir.path, 'container'));
  whatsappFixture(whatsapp);
  return { dir, whatsapp, out: join(dir.path, 'out.sqlite') };
}

test('chats and messages load as a reader reads them: who sent each, when, what it replies to, its media and its blobs', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const source = new WhatsAppDesktopSource(whatsapp.container);

  await (await pipeline(source, dir.path)).run();

  assert.deepEqual(table(out, 'chats', 'jid'), [
    {
      jid: '120363000000000001@g.us',
      sessionType: 1,
      partnerName: 'Trip',
      contactIdentifier: null,
      contactAbId: null,
      archived: 1,
      hidden: null,
      removed: null,
      flags: null,
      unreadCount: 0,
      messageCounter: null,
      identityVerificationState: null,
      identityVerificationEpoch: null,
      lastMessageDate: null,
      lastMessageText: null,
      locationSharingEndDate: null,
      savedInput: null,
      groupCreationDate: '2025-01-01T00:00:00.000000Z',
      groupCreatorJid: bobLid,
      groupOwnerJid: bobLid,
      groupSubjectTimestamp: '2025-02-01T00:00:00.000000Z',
      groupSubjectOwnerJid: aliceLid,
      groupPictureId: 'G-PIC',
      groupPicturePath: 'Media/Profile/group',
      groupSourceJid: null,
      groupState: 0,
    },
    ...[
      ['120363000000000002@newsletter', 5, 'News'],
      ['120363000000000003@g.us', 4, 'Neighbours'],
    ].map(([jid, sessionType, partnerName]) => ({
      jid,
      sessionType,
      partnerName,
      contactIdentifier: null,
      contactAbId: null,
      archived: 0,
      hidden: null,
      removed: null,
      flags: null,
      unreadCount: 0,
      messageCounter: null,
      identityVerificationState: null,
      identityVerificationEpoch: null,
      lastMessageDate: null,
      lastMessageText: null,
      locationSharingEndDate: null,
      savedInput: null,
      groupCreationDate: null,
      groupCreatorJid: null,
      groupOwnerJid: null,
      groupSubjectTimestamp: null,
      groupSubjectOwnerJid: null,
      groupPictureId: null,
      groupPicturePath: null,
      groupSourceJid: null,
      groupState: null,
    })),
    {
      jid: alice,
      sessionType: 0,
      partnerName: 'Alice',
      contactIdentifier: 'A1B2:ABPerson',
      contactAbId: 42,
      archived: 0,
      hidden: 0,
      removed: 0,
      flags: 256,
      unreadCount: 1,
      messageCounter: 9,
      identityVerificationState: 0,
      identityVerificationEpoch: 1,
      lastMessageDate: '2026-10-01T10:00:00.000000Z',
      lastMessageText: 'agJCMQ==',
      locationSharingEndDate: null,
      savedInput: 'see you',
      groupCreationDate: null,
      groupCreatorJid: null,
      groupOwnerJid: null,
      groupSubjectTimestamp: null,
      groupSubjectOwnerJid: null,
      groupPictureId: null,
      groupPicturePath: null,
      groupSourceJid: null,
      groupState: null,
    },
    ...[
      ['1700000000@broadcast', 2],
      ['9001@lid.status', 3],
    ].map(([jid, sessionType]) => ({
      jid,
      sessionType,
      partnerName: null,
      contactIdentifier: null,
      contactAbId: null,
      archived: 0,
      hidden: null,
      removed: null,
      flags: null,
      unreadCount: 0,
      messageCounter: null,
      identityVerificationState: null,
      identityVerificationEpoch: null,
      lastMessageDate: null,
      lastMessageText: null,
      locationSharingEndDate: null,
      savedInput: null,
      groupCreationDate: null,
      groupCreatorJid: null,
      groupOwnerJid: null,
      groupSubjectTimestamp: null,
      groupSubjectOwnerJid: null,
      groupPictureId: null,
      groupPicturePath: null,
      groupSourceJid: null,
      groupState: null,
    })),
  ]);

  const noMedia = {
    mediaLocalPath: null,
    mediaAvailableLocally: 0,
    thumbnailLocalPath: null,
    mediaUrl: null,
    mediaUrlDate: null,
    fileSize: null,
    movieDuration: null,
    aspectRatio: null,
    title: null,
    authorName: null,
    collectionName: null,
    vCardName: null,
    vCardString: null,
    latitude: null,
    longitude: null,
    hAccuracy: null,
    mediaOrigin: null,
    cloudStatus: null,
    metadata: null,
  };
  const plain = {
    sentDate: null,
    groupEventType: 2,
    messageErrorStatus: null,
    flags: null,
    starred: null,
    sort: null,
    childMessagesDeliveredCount: null,
    childMessagesReadCount: null,
    childMessagesPlayedCount: null,
    filteredRecipientCount: null,
    parentStanzaId: null,
    quotedStanzaId: null,
    quotedSenderJid: null,
    receiptInfo: null,
    attachmentRef: null,
  };
  const messages = table(out, 'messages', 'messageDate');
  assert.deepEqual(
    messages.map(({ chatJid, stanzaId }) => [chatJid, stanzaId]),
    [
      [alice, 'A1'],
      [alice, 'B1'],
      [alice, 'A2'],
      [group, 'G1'],
      [group, 'G2'],
      [group, 'G3'],
      [channel, 'N1'],
    ],
  );
  const [question, reply, document, photo, notice, link, post] = messages;
  assert.deepEqual(question, {
    ...plain,
    ...noMedia,
    chatJid: alice,
    isFromMe: 0,
    stanzaId: 'A1',
    senderJid: alice,
    fromJid: alice,
    toJid: null,
    groupMemberJid: null,
    pushName: 'Alice',
    messageDate: '2026-10-01T09:00:00.250123Z',
    messageType: 0,
    messageStatus: 6,
    flags: 16777216,
    starred: 1,
    sort: 1,
    text: 'Are you coming?',
  });
  assert.deepEqual(
    { ...reply, metadata: null, receiptInfo: null },
    {
      ...plain,
      ...noMedia,
      chatJid: alice,
      isFromMe: 1,
      stanzaId: 'B1',
      senderJid: null,
      fromJid: null,
      toJid: alice,
      groupMemberJid: null,
      pushName: null,
      messageDate: '2026-10-01T10:00:00.000000Z',
      sentDate: '2026-10-01T10:00:01.000000Z',
      messageType: 0,
      messageStatus: 8,
      text: 'Yes',
      quotedStanzaId: 'A1',
      quotedSenderJid: aliceLid,
    },
  );
  // The blobs keep every field WhatsApp wrote, the decoded ones too.
  assert.ok(reply?.metadata instanceof Uint8Array);
  assert.deepEqual(
    [...reply.metadata.subarray(0, 4)],
    [0x2a, 0x02, ...new TextEncoder().encode('A1')],
  );
  assert.ok(reply.receiptInfo instanceof Uint8Array);
  assert.ok(reply.receiptInfo.length > 40);
  assert.deepEqual(document, {
    ...plain,
    ...noMedia,
    chatJid: alice,
    isFromMe: 0,
    stanzaId: 'A2',
    senderJid: alice,
    fromJid: alice,
    toJid: null,
    groupMemberJid: null,
    pushName: null,
    messageDate: '2026-10-02T09:00:00.000000Z',
    messageType: 8,
    messageStatus: 6,
    text: 'The plan',
    mediaLocalPath: 'Media/15550001001@s.whatsapp.net/0/1/plan.pdf',
    mediaUrl: 'https://mmg.whatsapp.net/plan',
    fileSize: 2048,
    authorName: 'plan.pdf',
    vCardName: 'aGFzaA==',
    vCardString: 'application/pdf',
  });
  assert.deepEqual(
    { ...photo, attachmentRef: null },
    {
      ...plain,
      ...noMedia,
      chatJid: group,
      isFromMe: 0,
      stanzaId: 'G1',
      senderJid: bobLid,
      fromJid: group,
      toJid: null,
      groupMemberJid: bobLid,
      pushName: 'Bobby',
      messageDate: '2026-10-03T08:00:00.000000Z',
      messageType: 1,
      messageStatus: 6,
      sort: 4,
      text: null,
      mediaLocalPath: 'Media/120363000000000001@g.us/a/b/photo.jpg',
      mediaAvailableLocally: 1,
      thumbnailLocalPath: 'Media/120363000000000001@g.us/a/b/photo.thumb',
      mediaUrl: 'https://mmg.whatsapp.net/photo',
      mediaUrlDate: '2026-10-03T08:00:00.000000Z',
      fileSize: 4,
      aspectRatio: 1.5,
      title: 'At the lake',
      vCardName: 'cGhvdG8=',
      vCardString: 'image/jpeg',
      latitude: 900,
      longitude: 1600,
      mediaOrigin: 0,
      cloudStatus: 64,
    },
  );
  assert.deepEqual(notice, {
    ...plain,
    ...noMedia,
    chatJid: group,
    isFromMe: 0,
    stanzaId: 'G2',
    senderJid: null,
    fromJid: group,
    toJid: null,
    groupMemberJid: null,
    pushName: null,
    messageDate: '2026-10-03T09:00:00.000000Z',
    messageType: 6,
    groupEventType: 38,
    messageStatus: null,
    text: 'Bob changed the subject',
  });
  assert.deepEqual(link, {
    ...plain,
    ...noMedia,
    chatJid: group,
    isFromMe: 1,
    stanzaId: 'G3',
    senderJid: null,
    fromJid: null,
    toJid: group,
    groupMemberJid: null,
    pushName: null,
    messageDate: '2026-10-04T09:00:00.000000Z',
    messageType: 7,
    messageStatus: null,
    text: 'Look https://example.com',
    parentStanzaId: 'G1',
    mediaUrl: 'https://example.com',
    title: 'Example',
  });
  assert.deepEqual(
    { ...post, receiptInfo: null },
    {
      ...plain,
      ...noMedia,
      chatJid: channel,
      isFromMe: 0,
      stanzaId: 'N1',
      senderJid: null,
      fromJid: channel,
      toJid: null,
      groupMemberJid: null,
      pushName: null,
      messageDate: '2026-10-05T09:00:00.000000Z',
      messageType: 0,
      messageStatus: null,
      text: 'Headline',
    },
  );
  // The keys WhatsApp downloads media and checks devices by stay out.
  assert.ok(!messages.some((message) => 'mediaKey' in message));
});

test('receipts, reactions and channel reaction counts decode from each message’s receipt info, with the message they are on', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;

  await (
    await pipeline(new WhatsAppDesktopSource(whatsapp.container), dir.path)
  ).run();

  const onReply = { chatJid: alice, messageIsFromMe: 1, messageStanzaId: 'B1' };
  assert.deepEqual(table(out, 'messageReceipts', 'recipientJid'), [
    {
      ...onReply,
      recipientJid: '1313@bot',
      deliveredAt: null,
      readAt: null,
      playedAt: null,
    },
    {
      ...onReply,
      recipientJid: alice,
      deliveredAt: '2026-10-01T10:00:00Z',
      readAt: null,
      playedAt: null,
    },
    {
      ...onReply,
      recipientJid: aliceLid,
      deliveredAt: '2026-10-01T10:00:02Z',
      readAt: '2026-10-01T10:00:30Z',
      playedAt: '2026-10-01T10:01:30Z',
    },
  ]);
  assert.deepEqual(table(out, 'messageReactions', 'reactionStanzaId'), [
    {
      ...onReply,
      reactionStanzaId: 'R1',
      senderJid: null,
      isFromMe: 1,
      emoji: '👍',
      reactedAt: '2026-10-01T10:00:05.123Z',
    },
    {
      ...onReply,
      reactionStanzaId: 'R2',
      senderJid: aliceLid,
      isFromMe: 0,
      emoji: null,
      reactedAt: '2026-10-01T10:00:09.000Z',
    },
  ]);
  assert.deepEqual(table(out, 'messageReactionCounts', 'emoji'), [
    {
      chatJid: channel,
      messageIsFromMe: 0,
      messageStanzaId: 'N1',
      emoji: '❤️',
      count: 10,
    },
    {
      chatJid: channel,
      messageIsFromMe: 0,
      messageStanzaId: 'N1',
      emoji: '😂',
      count: 1,
    },
  ]);
});

test('outgoing reactions follow this account’s add, replacement and withdrawal without duplicating other reactions', async () => {
  const { dir, whatsapp, out } = await scratch();
  try {
    const run = await pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
      ({ name }) => name === 'messageReactions',
    );
    // Native WhatsApp 26.40 stores this Mac's outgoing reaction in 7.2,
    // alongside other senders in 7.1. Withdrawal omits the emoji.
    for (const [stanzaId, emoji, time, reactedAt] of [
      ['OUT1', '👍', 1_790_848_805_123, '2026-10-01T10:00:05.123Z'],
      ['OUT2', '❤️', 1_790_848_806_123, '2026-10-01T10:00:06.123Z'],
      ['OUT3', null, 1_790_848_807_123, '2026-10-01T10:00:07.123Z'],
    ] as const) {
      const outgoing: [number, ProtobufValue][] = [
        [1, stanzaId],
        [3, time],
        [4, 1],
        [7, 0],
      ];
      if (emoji !== null) outgoing.push([2, emoji]);
      {
        using database = new DatabaseSync(whatsapp.path('chatStorage'));
        database
          .prepare(
            'UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = ?, Z_OPT = Z_OPT + 1 WHERE Z_PK = 1',
          )
          .run(
            protobuf([
              [
                7,
                {
                  message: [
                    [
                      1,
                      {
                        message: [
                          [1, 'R2'],
                          [2, aliceLid],
                          [3, '😂'],
                          [4, 1_790_848_809_000],
                        ],
                      },
                    ],
                    [2, { message: outgoing }],
                  ],
                },
              ],
            ]),
          );
      }

      await run.run();

      assert.deepEqual(table(out, 'messageReactions', 'reactionStanzaId'), [
        {
          chatJid: alice,
          messageIsFromMe: 1,
          messageStanzaId: 'B1',
          reactionStanzaId: stanzaId,
          senderJid: null,
          isFromMe: 1,
          emoji,
          reactedAt,
        },
        {
          chatJid: alice,
          messageIsFromMe: 1,
          messageStanzaId: 'B1',
          reactionStanzaId: 'R2',
          senderJid: aliceLid,
          isFromMe: 0,
          emoji: '😂',
          reactedAt: '2026-10-01T10:00:09.000Z',
        },
      ]);
      assert.deepEqual(counts(await run.run()), {
        messageReactions: { count: 0, deleted: 0 },
      });
    }
  } finally {
    await dir.remove();
  }
});

test('what ChatStorage keeps beside messages loads: links found in them, albums, group members and their changes, names, pictures, blocks and chat settings', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;

  await (
    await pipeline(new WhatsAppDesktopSource(whatsapp.container), dir.path)
  ).run();

  assert.deepEqual(table(out, 'messageDataItems', '"index"'), [
    {
      chatJid: group,
      messageIsFromMe: 1,
      messageStanzaId: 'G3',
      index: 0,
      type: 0,
      date: '2026-10-04T09:00:00.000000Z',
      content1: 'https://example.com',
      content2: null,
      title: 'Example',
      summary: 'An example page',
      matchedText: 'https://example.com',
      sectionId: '2026-10',
      senderJid: null,
      thumbnailPath: null,
      ownsThumbnail: null,
    },
  ]);
  assert.deepEqual(table(out, 'messageAssociations', 'stanzaId'), [
    {
      chatJid: group,
      stanzaId: 'G3',
      type: 1,
      parentStanzaId: 'G1',
      sort: 5,
    },
  ]);
  assert.deepEqual(table(out, 'groupMembers', 'groupJid, memberJid'), [
    {
      groupJid: group,
      memberJid: aliceLid,
      contactName: 'Alice',
      firstName: 'Alice',
      contactIdentifier: 'A1B2:ABPerson',
      contactAbId: 42,
      isActive: 0,
      isAdmin: 0,
    },
    {
      groupJid: group,
      memberJid: bobLid,
      contactName: 'Bob',
      firstName: 'Bob',
      contactIdentifier: null,
      contactAbId: null,
      isActive: 1,
      isAdmin: 1,
    },
    {
      groupJid: '120363000000000003@g.us',
      memberJid: '9003@lid',
      contactName: 'Carol',
      firstName: null,
      contactIdentifier: null,
      contactAbId: null,
      isActive: 1,
      isAdmin: 0,
    },
  ]);
  assert.deepEqual(table(out, 'groupMembersChanges', 'changeDate'), [
    {
      groupJid: group,
      changeDate: '2026-09-01T08:00:00.000000Z',
      changeType: 4,
      memberJids: aliceLid,
    },
  ]);
  assert.deepEqual(table(out, 'pushNames', 'jid'), [
    { jid: bobLid, pushName: 'Bobby' },
  ]);
  assert.deepEqual(
    table(out, 'profilePictures', 'jid').map(({ attachmentRef, ...row }) => ({
      ...row,
      file: attachmentRef !== null,
    })),
    [
      {
        jid: aliceLid,
        pictureId: 'P-1',
        path: 'Media/Profile/9001-1',
        availableLocally: 1,
        requestDate: '2026-09-02T00:00:00.000000Z',
        file: true,
      },
      {
        jid: bobLid,
        pictureId: 'P-2',
        path: 'Media/Profile/9002-1',
        availableLocally: 0,
        requestDate: null,
        file: false,
      },
    ],
  );
  assert.deepEqual(table(out, 'blockedContacts', 'jid'), [
    { jid: '15550006666@s.whatsapp.net' },
  ]);
  assert.deepEqual(table(out, 'chatPushConfigs', 'jid'), [
    {
      jid: alice,
      alerts: 0,
      mutedUntil: '4001-01-01T00:00:00.000000Z',
      sound: 'note',
      ringtone: null,
    },
    {
      jid: '15550009999@s.whatsapp.net',
      alerts: 1,
      mutedUntil: null,
      sound: null,
      ringtone: 'ring',
    },
  ]);
});

test('contacts, users with the phone number behind each LID, and calls with their call-log entry and every participant the entry lists load', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;

  await (
    await pipeline(new WhatsAppDesktopSource(whatsapp.container), dir.path)
  ).run();

  assert.deepEqual(table(out, 'contacts', 'uniqueId'), [
    {
      uniqueId: '0A1B2C3D-0000-4000-8000-000000000001',
      whatsappId: alice,
      lid: aliceLid,
      interopJid: null,
      identifier: 'A1B2:ABPerson',
      fullName: 'Alice Smith',
      givenName: 'Alice',
      lastName: 'Smith',
      businessName: null,
      highlightedName: 'Alice',
      username: null,
      phoneNumber: '15550001001',
      localizedPhoneNumber: '+1 555-000-1001',
      phoneNumberLabel: 'mobile',
      phoneStatus: 1,
      aboutText: 'Busy',
      aboutEmoji: null,
      aboutTimestamp: '2026-01-01T00:00:00.000000Z',
      aboutExpirationTimestamp: null,
      notes: null,
      disappearingModeDuration: 0,
      disappearingModeTimestamp: null,
      source: 1,
      syncPolicy: 1,
      lastUpdated: '2026-10-01T00:00:00.000000Z',
    },
  ]);
  assert.deepEqual(table(out, 'users', 'lid'), [
    {
      lid: aliceLid,
      phoneNumber: '15550001001',
      countryCode: 'US',
      displayName: 'Alice',
      username: null,
      userType: 0,
      state: 1,
      phoneNumberSharingState: 1,
      usernameState: null,
      createdAt: '2026-03-01T00:00:00.000000Z',
      additionalData: null,
    },
    {
      lid: bobLid,
      phoneNumber: null,
      countryCode: null,
      displayName: 'Bob',
      username: 'bob',
      userType: 0,
      state: 1,
      phoneNumberSharingState: 0,
      usernameState: 0,
      createdAt: '0000-12-30T00:00:00.000000Z',
      additionalData: null,
    },
  ]);
  assert.deepEqual(table(out, 'calls', 'callId'), [
    {
      callId: 'CALL-GROUP',
      date: '2026-09-11T18:00:00.000000Z',
      duration: 0,
      outcome: 1,
      bytesSent: 0,
      bytesReceived: 0,
      groupJid: group,
      groupCallCreatorJid: bobLid,
      isBotGroupCall: 0,
      isLightweight: 0,
      reminderId: null,
      scheduledId: '',
      incoming: 1,
      missed: 1,
      missedReason: 1,
      video: 0,
      firstDate: '2026-09-11T18:00:00.000000Z',
      linkToken: '',
    },
    {
      callId: 'CALL-VIDEO',
      date: '2026-09-10T18:00:00.000000Z',
      duration: 125.5,
      outcome: 0,
      bytesSent: 1000,
      bytesReceived: 2000,
      groupJid: null,
      groupCallCreatorJid: null,
      isBotGroupCall: 0,
      isLightweight: 0,
      reminderId: null,
      scheduledId: '',
      incoming: 0,
      missed: 0,
      missedReason: 1,
      video: 1,
      firstDate: '2026-09-10T18:00:00.000000Z',
      linkToken: '',
    },
  ]);
  assert.deepEqual(table(out, 'callParticipants', 'callId, jid'), [
    { callId: 'CALL-GROUP', jid: aliceLid, outcome: 1 },
    { callId: 'CALL-GROUP', jid: bobLid, outcome: 4 },
    { callId: 'CALL-VIDEO', jid: alice, outcome: 0 },
  ]);
  // The contact's device list is a key WhatsApp encrypts by; it stays out.
  assert.ok(
    !table(out, 'contacts', 'uniqueId').some((row) => 'deviceList' in row),
  );
});

test('business profiles load with their websites, linked accounts, hours, categories in order, areas and prompts, and every verified name, one with no profile', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;

  await (
    await pipeline(new WhatsAppDesktopSource(whatsapp.container), dir.path)
  ).run();

  const shop = '15550007777@s.whatsapp.net';
  assert.deepEqual(table(out, 'businessProfiles', 'jid'), [
    {
      jid: shop,
      description: 'Fresh bread',
      address: '1 Main St',
      latitude: 31.95,
      longitude: 35.91,
      email: 'shop@example.com',
      websites: '["https://a.example","https://b.example"]',
      timezone: 'Asia/Amman',
      memberSinceDate: '2020-05-01T00:00:00.000000Z',
      memberSinceText: 'Joined in May, 2020',
      customUrl: null,
      vertical: null,
      canonicalVertical: null,
      parentCompanyName: null,
      parentCompanyLogoUrl: null,
      isAuthorizedAgent: null,
      commerceExperience: 'catalog',
      cartEnabled: 1,
      shopUrl: 'https://shop.example',
      isVideoCallingEnabled: 0,
      automatedType: '1p_partial',
      coverPhotoId: '1234567890123456',
      coverPhotoUrl: 'https://media.example/cover',
      facebookPageId: '100200300400500',
      facebookPageName: 'Shop Page',
      facebookLikes: 120,
      instagramHandle: 'shop.gram',
      instagramFollowers: 300,
    },
  ]);
  // The serial loads as a 64-bit integer; read as text, it shows no rounding.
  assert.deepEqual(
    rows(
      out,
      `SELECT lid, "phoneNumberJid", name, "verificationLevel", expires,
              CAST("certificateSerial" AS TEXT) AS "certificateSerial",
              "certificateIssuer", "certificateIssuedAt", "roleActor",
              "roleHostStorage", "roleUpdatedAt"
       FROM "businessVerifiedNames" ORDER BY lid`,
    ),
    [
      {
        lid: '7777@lid',
        phoneNumberJid: shop,
        name: 'The Shop',
        verificationLevel: 3,
        expires: null,
        certificateSerial: '9007199254740993',
        certificateIssuer: 'ent:wa',
        certificateIssuedAt: '2018-07-13T00:00:00Z',
        roleActor: 2,
        roleHostStorage: 2,
        roleUpdatedAt: '2026-09-14T12:00:00Z',
      },
      {
        lid: '8888@lid',
        phoneNumberJid: null,
        name: 'No Profile',
        verificationLevel: 1,
        expires: null,
        certificateSerial: '5',
        certificateIssuer: 'smb:wa',
        certificateIssuedAt: null,
        roleActor: null,
        roleHostStorage: null,
        roleUpdatedAt: null,
      },
    ],
  );
  assert.deepEqual(table(out, 'businessCategories', 'position'), [
    { jid: shop, categoryId: '1600', position: 0, name: 'Bakery' },
    { jid: shop, categoryId: '2250', position: 1, name: 'Grocery Store' },
  ]);
  assert.deepEqual(table(out, 'businessHours', 'day'), [
    { jid: shop, day: 2, openTime: 540, mode: 1, closeTime: 1020 },
    { jid: shop, day: 3, openTime: 600, mode: 1, closeTime: 1080 },
  ]);
  assert.deepEqual(table(out, 'businessServiceAreas', 'position'), [
    {
      jid: shop,
      position: 0,
      latitude: 31.9,
      longitude: 35.9,
      radiusMeters: 1000,
      description: 'Downtown',
    },
  ]);
  assert.deepEqual(table(out, 'businessBotPrompts', 'position'), [
    { jid: shop, text: 'What is fresh?', position: 0, emoji: '🥖' },
    { jid: shop, text: 'Is it open?', position: 1, emoji: null },
  ]);
});

test('sticker packs, stickers, favorites and recents load, and so do the privacy settings, message timers, linked profiles and number changes WhatsApp keeps', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;

  await (
    await pipeline(new WhatsAppDesktopSource(whatsapp.container), dir.path)
  ).run();

  const pack = {
    name: 'Cuppy',
    publisher: 'WhatsApp',
    description: 'A cup',
    fileSize: 1000,
    stickerCount: 25,
    premiumStickerCount: null,
    imageDataHash: 'IMGHASH',
    trayImageId: 'TRAY1',
  };
  assert.deepEqual(table(out, 'stickerPacks', 'stickerPackId, inTray'), [
    {
      ...pack,
      stickerPackId: 'cuppy',
      inTray: 0,
      order: 4,
      flags: 2,
      trayImageFilePath: null,
      previewImageIds: '[]',
    },
    {
      ...pack,
      stickerPackId: 'cuppy',
      inTray: 1,
      order: 0,
      flags: 1,
      trayImageFilePath: 'packdir/tray.png',
      previewImageIds: '[]',
    },
    {
      stickerPackId: 'flump',
      inTray: 0,
      name: 'Flump',
      publisher: null,
      description: null,
      fileSize: null,
      stickerCount: null,
      premiumStickerCount: null,
      order: 5,
      flags: 7,
      imageDataHash: null,
      trayImageId: null,
      trayImageFilePath: null,
      previewImageIds: '["PREVIEW1","PREVIEW2"]',
    },
  ]);
  assert.deepEqual(
    table(out, 'stickers', 'fileHash').map(({ attachmentRef, ...row }) => ({
      ...row,
      file: attachmentRef !== null,
    })),
    [
      {
        fileHash: 'HASH1',
        stickerPackId: 'cuppy',
        sort: 0,
        mimeType: 'image/webp',
        width: 512,
        height: 512,
        fileLength: 100,
        flags: 128,
        emojis: '☕ 😀',
        accessibilityText: 'A happy cup',
        imageHash: 'IMG1',
        relativeImagePath: 'packdir/one.webp',
        availableLocally: 1,
        file: true,
      },
      {
        fileHash: 'HASH2',
        stickerPackId: null,
        sort: 0,
        mimeType: 'image/webp',
        width: 0,
        height: 0,
        fileLength: 200,
        flags: 1,
        emojis: null,
        accessibilityText: null,
        imageHash: 'IMG2',
        relativeImagePath: 'no-sticker-pack/two.webp',
        availableLocally: 1,
        file: true,
      },
      {
        fileHash: 'HASH3',
        stickerPackId: null,
        sort: 0,
        mimeType: 'application/was',
        width: 0,
        height: 0,
        fileLength: 300,
        flags: 0,
        emojis: null,
        accessibilityText: null,
        imageHash: 'IMG3',
        relativeImagePath: null,
        availableLocally: 0,
        file: false,
      },
    ],
  );
  assert.deepEqual(table(out, 'favoriteStickers', 'fileHash'), [
    { fileHash: 'HASH2', favoritedAt: '2025-04-29T12:00:00.000000Z' },
  ]);
  assert.deepEqual(table(out, 'recentStickers', 'position'), [
    { fileHash: 'HASH2', position: 0, score: 1.5, lastUsed: 1791702449217 },
    { fileHash: 'HASH3', position: 1, score: 0.25, lastUsed: 1 },
  ]);
  assert.deepEqual(table(out, 'privacySettings', 'category'), [
    { category: 'groupadd', value: 'contacts' },
    { category: 'last', value: 'none' },
  ]);
  assert.deepEqual(table(out, 'disappearingModes', 'lid'), [
    {
      lid: aliceLid,
      durationSeconds: 604800,
      setAt: '2026-03-13T10:00:00Z',
    },
    { lid: bobLid, durationSeconds: 0, setAt: null },
  ]);
  assert.deepEqual(table(out, 'linkedProfiles', 'lid'), [
    {
      lid: aliceLid,
      type: 'INSTAGRAM',
      username: 'alice.s',
      url: 'https://instagram.com/alice.s',
    },
  ]);
  assert.deepEqual(table(out, 'changedNumbers', 'oldJid'), [
    {
      oldJid: '15550001111@s.whatsapp.net',
      newJid: '15550002222@s.whatsapp.net',
      changedAt: '2026-08-01T00:00:00.000000Z',
    },
  ]);
});

// The first run of a fresh history once change has broken it: which streams
// failed, how, and what the rest loaded.
async function failedAfter(change: (whatsapp: ScratchWhatsApp) => void) {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  change(whatsapp);
  const run = await pipeline(
    new WhatsAppDesktopSource(whatsapp.container),
    dir.path,
  );
  let caught: unknown;
  try {
    await run.run();
  } catch (error) {
    caught = error;
  }
  const result = failures(caught);
  // A stream that never loaded has no table.
  const loaded =
    rows(out, "SELECT 1 FROM sqlite_master WHERE name = 'messages'").length > 0;
  return {
    ...result,
    messages: loaded
      ? rows(out, 'SELECT count(*) AS n FROM messages')[0]?.n
      : 0,
  };
}

const removeStore = (whatsapp: ScratchWhatsApp, store: Store) => {
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${whatsapp.path(store)}${suffix}`, { force: true });
};

test('a store WhatsApp has not created, or macOS denies, fails only the streams that read it, as the user’s to fix; one that is no database fails as the system’s', async () => {
  const missing = await failedAfter((whatsapp) =>
    removeStore(whatsapp, 'businesses'),
  );
  assert.deepEqual(missing.streams, streamsOf.businesses);
  assert.deepEqual(missing.types, ['config']);
  for (const error of missing.errors) {
    assert.ok(error instanceof WhatsAppUnavailableError);
    assert.match(error.message, /Biz\.sqlite.*Full Disk Access/s);
  }
  assert.equal(missing.messages, 7);

  const { dir, whatsapp } = await scratch();
  await using _ = dir;
  // chmod stands in for macOS withdrawing Full Disk Access.
  await chmod(whatsapp.path('chatStorage'), 0o000);
  try {
    const run = await pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
    );
    await assert.rejects(run.run(), (error) => {
      const denied = failures(error);
      assert.deepEqual(denied.streams, streamsOf.chatStorage);
      assert.deepEqual(denied.types, ['config']);
      return true;
    });
    assert.equal(
      rows(join(dir.path, 'out.sqlite'), 'SELECT count(*) AS n FROM users')[0]
        ?.n,
      2,
    );
  } finally {
    await chmod(whatsapp.path('chatStorage'), 0o644);
  }

  const garbled = await failedAfter((whatsapp) => {
    removeStore(whatsapp, 'stickers');
    writeFileSync(
      whatsapp.path('stickers'),
      'not a database, but long enough to be read',
    );
  });
  assert.deepEqual(garbled.streams, streamsOf.stickers);
  assert.deepEqual(garbled.types, ['system']);
});

test('a store lacking a column or table this reader reads fails only that store’s streams, naming what is missing', async () => {
  const breaks: [Store, string, RegExp][] = [
    [
      'chatStorage',
      'ALTER TABLE ZWAMESSAGE DROP COLUMN ZTEXT',
      /ZWAMESSAGE\.ZTEXT/,
    ],
    [
      'contacts',
      'ALTER TABLE ZWAADDRESSBOOKCONTACT DROP COLUMN ZFULLNAME',
      /ZWAADDRESSBOOKCONTACT\.ZFULLNAME/,
    ],
    [
      'users',
      'ALTER TABLE ZWAZACCOUNT DROP COLUMN ZPHONENUMBER',
      /ZWAZACCOUNT\.ZPHONENUMBER/,
    ],
    [
      'calls',
      'ALTER TABLE ZWACDCALLEVENTPARTICIPANT DROP COLUMN Z1PARTICIPANTS',
      /ZWACDCALLEVENTPARTICIPANT\.Z\*PARTICIPANTS/,
    ],
    [
      'messageAssociations',
      'ALTER TABLE message_parent_association DROP COLUMN sort',
      /message_parent_association\.sort/,
    ],
    [
      'businesses',
      'ALTER TABLE ZWABIZPROFILEDATA DROP COLUMN ZEMAIL',
      /ZWABIZPROFILEDATA\.ZEMAIL/,
    ],
    [
      'stickers',
      "DELETE FROM Z_PRIMARYKEY WHERE Z_NAME = 'WACDStoreStickerPack'",
      /Z_PRIMARYKEY\.WACDStoreStickerPack/,
    ],
    [
      'localKeyValue',
      'ALTER TABLE ZWAKEYVALUEELEMENT DROP COLUMN ZDATE',
      /ZWAKEYVALUEELEMENT\.ZDATE/,
    ],
    [
      'backedUpKeyValue',
      'DROP TABLE ZWAKEYVALUEELEMENT',
      /ZWAKEYVALUEELEMENT\.Z_PK/,
    ],
  ];
  for (const [store, sql, named] of breaks) {
    const broken = await failedAfter((whatsapp) => whatsapp.exec(store, sql));
    assert.deepEqual(broken.streams, streamsOf[store], store);
    for (const error of broken.errors) {
      assert.ok(error instanceof WhatsAppSchemaError, store);
      assert.match(error.message, named);
    }
    assert.equal(broken.messages, store === 'chatStorage' ? 0 : 7, store);
  }
});

test('a blob this reader cannot decode fails the streams decoded from it and keeps what they loaded, rather than reading as empty', async () => {
  const breaks: [
    string,
    Store,
    string,
    Record<string, SQLInputValue>,
    string[],
  ][] = [
    [
      'a receipt naming a recipient of an unknown kind',
      'chatStorage',
      'UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = ?, Z_OPT = Z_OPT + 1 WHERE Z_PK = 1',
      { receipt: protobuf([[2, { message: [[1, packedJid(0x99, '1')]] }]]) },
      ['messageReactionCounts', 'messageReactions', 'messageReceipts'],
    ],
    [
      'message metadata cut short',
      'chatStorage',
      'UPDATE ZWAMEDIAITEM SET ZMETADATA = ?, Z_OPT = Z_OPT + 1 WHERE Z_PK = 2',
      { metadata: Uint8Array.from([0x2a, 0x10, 0x41]) },
      [
        'messageReactionCounts',
        'messageReactions',
        'messageReceipts',
        'messages',
      ],
    ],
    [
      'business hours that are not a list',
      'businesses',
      'UPDATE ZWABIZPROFILEDATA SET ZHOURSCONFIGS = ?',
      { hours: archivedProtobuf('WABizHoursConfig', new Uint8Array()) },
      ['businessHours'],
    ],
    [
      'a sticker store listing whose previews are not a list of IDs',
      'stickers',
      'UPDATE ZWACDABSTRACTSTICKERPACK SET ZPREVIEWIMAGEIDS = ? WHERE Z_PK = 3',
      { previews: archivedProtobuf('NSString', new Uint8Array()) },
      ['stickerPacks'],
    ],
    [
      'a message timer that is no protobuf',
      'localKeyValue',
      "UPDATE ZWAKEYVALUEELEMENT SET ZVALUE = ? WHERE ZNAMESPACE = 'disappearing-mode'",
      { timer: Uint8Array.from([0x0f]) },
      ['disappearingModes'],
    ],
    [
      'a recent sticker without its hash',
      'backedUpKeyValue',
      "UPDATE ZWAKEYVALUEELEMENT SET ZVALUE = ? WHERE ZNAMESPACE = 'rs.v2'",
      { recents: protobuf([[1, { message: [[3, 1]] }]]) },
      ['recentStickers'],
    ],
  ];
  for (const [what, store, sql, values, failed] of breaks) {
    const { dir, whatsapp, out } = await scratch();
    await using _ = dir;
    const run = await pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
    );
    await run.run();
    const loaded = Object.fromEntries(
      failed.map((name) => [
        name,
        rows(out, `SELECT count(*) AS n FROM "${name}"`)[0]?.n,
      ]),
    );
    for (const [name, count] of Object.entries(loaded))
      assert.ok(Number(count) > 0, `${what}: ${name} loaded nothing to keep`);
    {
      using database = new DatabaseSync(whatsapp.path(store));
      database.prepare(sql).run(...Object.values(values));
    }

    await assert.rejects(run.run(), (error) => {
      assert.deepEqual(failures(error).streams, failed, what);
      assert.deepEqual(failures(error).types, ['system'], what);
      return true;
    });

    assert.deepEqual(
      Object.fromEntries(
        failed.map((name) => [
          name,
          rows(out, `SELECT count(*) AS n FROM "${name}"`)[0]?.n,
        ]),
      ),
      loaded,
      what,
    );
  }
});

test('compact message scans keep unchanged groups across reopened pipelines and reload only an edited message', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const selected = new Set([
    'messages',
    'messageReceipts',
    'messageReactions',
    'messageReactionCounts',
  ]);
  const open = () =>
    pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
      ({ name }) => selected.has(name),
    );
  // As in Mail's integration test, saved group fingerprints expose reuse:
  // rereading the same payload would otherwise produce identical output.
  const groups = () =>
    Object.fromEntries(
      rows(
        join(dir.path, 'state.sqlite'),
        'SELECT id, state FROM checkpoints ORDER BY id',
      ).map(({ id, state }) => [String(id), JSON.parse(String(state)).groups]),
    );
  const first = await open();
  await first.run();
  const saved = groups();
  for (const name of selected)
    assert.ok(saved[name], `${name} must save compact message groups`);
  const original = table(out, 'messages', 'stanzaId');
  const unchanged = Object.fromEntries(
    [...selected].map((name) => [name, { count: 0, deleted: 0 }]),
  );
  assert.deepEqual(counts(await (await open()).run()), unchanged);
  assert.deepEqual(groups(), saved);

  whatsapp.exec(
    'chatStorage',
    "UPDATE ZWAMESSAGE SET ZTEXT = 'Edited while stopped', Z_OPT = Z_OPT + 1 WHERE Z_PK = 1",
  );
  assert.deepEqual(counts(await (await open()).run()), {
    ...unchanged,
    messages: { count: 1, deleted: 0 },
  });
  assert.deepEqual(
    table(out, 'messages', 'stanzaId'),
    original.map((row) =>
      row.stanzaId === 'A1' ? { ...row, text: 'Edited while stopped' } : row,
    ),
  );
  const edited = groups();
  for (const name of selected) {
    assert.deepEqual(Object.keys(edited[name]), Object.keys(saved[name]));
    assert.equal(
      Object.keys(saved[name]).filter(
        (key) => edited[name][key].fingerprint !== saved[name][key].fingerprint,
      ).length,
      1,
    );
  }
  assert.deepEqual(counts(await (await open()).run()), unchanged);
});

test('compact message scans reread a replaced Core Data store even when row IDs and versions repeat', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  whatsapp.exec(
    'chatStorage',
    `
    UPDATE Z_METADATA SET Z_UUID = 'first-store';
  `,
  );
  const open = () =>
    pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
      ({ name }) => name === 'messages',
    );
  await (await open()).run();
  const replacement = join(dir.path, 'replacement.sqlite');
  {
    using database = new DatabaseSync(whatsapp.path('chatStorage'));
    database.prepare('VACUUM INTO ?').run(replacement);
  }
  {
    using database = new DatabaseSync(replacement);
    database.exec(
      "UPDATE ZWAMESSAGE SET ZTEXT = 'From the replacement store' WHERE Z_PK = 1",
    );
  }
  renameSync(replacement, whatsapp.path('chatStorage'));

  assert.deepEqual(counts(await (await open()).run()), {
    messages: { count: 1, deleted: 0 },
  });
  assert.deepEqual(
    rows(out, "SELECT text FROM messages WHERE stanzaId = 'A1'"),
    [{ text: 'From the replacement store' }],
  );
});

test('compact message scans catch independent receipt and channel-count changes without a message version change', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const run = await pipeline(
    new WhatsAppDesktopSource(whatsapp.container),
    dir.path,
    ({ name }) =>
      [
        'messages',
        'messageReceipts',
        'messageReactions',
        'messageReactionCounts',
      ].includes(name),
  );
  await run.run();
  const recipient: [number, ProtobufValue][] = [[1, packedJid(0x8c, '9001')]];
  for (const [field, offset, expected] of [
    [4, 1, ['2026-10-01T10:00:01Z', null, null]],
    [5, 2, ['2026-10-01T10:00:01Z', '2026-10-01T10:00:02Z', null]],
    [
      6,
      3,
      ['2026-10-01T10:00:01Z', '2026-10-01T10:00:02Z', '2026-10-01T10:00:03Z'],
    ],
  ] as const) {
    recipient.push([field, offset]);
    {
      using database = new DatabaseSync(whatsapp.path('chatStorage'));
      database
        .prepare(
          'UPDATE ZWAMESSAGEINFO SET Z_OPT = Z_OPT + 1, ZRECEIPTINFO = ? WHERE Z_PK = 1',
        )
        .run(
          protobuf([
            [3, 1790848800],
            [2, { message: recipient }],
          ]),
        );
    }
    const result = counts(await run.run());
    assert.equal(result.messages?.count, 1);
    assert.equal(result.messageReceipts?.count, 1);
    assert.deepEqual(
      rows(
        out,
        'SELECT recipientJid, deliveredAt, readAt, playedAt FROM messageReceipts',
      ),
      [
        {
          recipientJid: aliceLid,
          deliveredAt: expected[0],
          readAt: expected[1],
          playedAt: expected[2],
        },
      ],
    );
    assert.deepEqual(
      rows(
        whatsapp.path('chatStorage'),
        'SELECT Z_OPT AS version FROM ZWAMESSAGE WHERE Z_PK = 2',
      ),
      [{ version: 1 }],
    );
  }
  {
    using database = new DatabaseSync(whatsapp.path('chatStorage'));
    database
      .prepare(
        'UPDATE ZWAMESSAGEINFO SET Z_OPT = Z_OPT + 1, ZRECEIPTINFO = ? WHERE Z_PK = 2',
      )
      .run(
        protobuf([
          [
            7,
            {
              message: [
                [
                  3,
                  {
                    message: [
                      [
                        1,
                        {
                          message: [
                            [1, '❤️'],
                            [2, 11],
                          ],
                        },
                      ],
                    ],
                  },
                ],
              ],
            },
          ],
        ]),
      );
  }
  assert.deepEqual(counts(await run.run()).messageReactionCounts, {
    count: 1,
    deleted: 1,
  });
  assert.deepEqual(
    rows(out, 'SELECT emoji, count FROM messageReactionCounts'),
    [{ emoji: '❤️', count: 11 }],
  );
  whatsapp.exec('chatStorage', 'DELETE FROM ZWAMESSAGEINFO WHERE Z_PK = 2');
  assert.deepEqual(counts(await run.run()).messageReactionCounts, {
    count: 0,
    deleted: 1,
  });
  assert.deepEqual(rows(out, 'SELECT emoji FROM messageReactionCounts'), []);
});

test('compact message scans follow joined rows, local files and the first duplicate, then reconcile revoked and vanished messages', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const run = await pipeline(
    new WhatsAppDesktopSource(whatsapp.container),
    dir.path,
    ({ name }) => name === 'messages',
  );
  await run.run();
  whatsapp.exec(
    'chatStorage',
    "UPDATE ZWAMEDIAITEM SET ZTITLE = 'New caption', Z_OPT = Z_OPT + 1 WHERE Z_PK = 4",
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(out, "SELECT title FROM messages WHERE stanzaId = 'G1'"),
    [{ title: 'New caption' }],
  );
  // The joined member changes; the message's version does not.
  whatsapp.exec(
    'chatStorage',
    "UPDATE ZWAGROUPMEMBER SET ZMEMBERJID = '9009@lid' WHERE Z_PK = 1",
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(out, "SELECT senderJid FROM messages WHERE stanzaId = 'G1'"),
    [{ senderJid: '9009@lid' }],
  );
  rmSync(
    join(
      whatsapp.container,
      'Message/Media/120363000000000001@g.us/a/b/photo.jpg',
    ),
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(
      out,
      "SELECT mediaAvailableLocally FROM messages WHERE stanzaId = 'G1'",
    ),
    [{ mediaAvailableLocally: 0 }],
  );
  whatsapp.file('Message/Media/120363000000000001@g.us/a/b/photo.jpg', 'jpeg');
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 0 });
  // Replacing a related row with one at the same version must still reload it.
  whatsapp.exec(
    'chatStorage',
    `UPDATE ZWAMEDIAITEM SET Z_OPT = 2, ZTITLE = 'Replacement caption' WHERE Z_PK = 5;
    UPDATE ZWAMESSAGE SET ZMEDIAITEM = 5, Z_OPT = Z_OPT + 1 WHERE Z_PK = 4;`,
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(out, "SELECT title FROM messages WHERE stanzaId = 'G1'"),
    [{ title: 'Replacement caption' }],
  );
  // The second physical copy becomes the winner; the child loses its parent.
  whatsapp.exec('chatStorage', 'DELETE FROM ZWAMESSAGE WHERE Z_PK = 4');
  assert.deepEqual(counts(await run.run()).messages, { count: 2, deleted: 0 });
  assert.deepEqual(
    rows(out, "SELECT sort FROM messages WHERE stanzaId = 'G1'"),
    [{ sort: 40 }],
  );
  assert.deepEqual(
    rows(out, "SELECT parentStanzaId FROM messages WHERE stanzaId = 'G3'"),
    [{ parentStanzaId: null }],
  );
  whatsapp.exec(
    'chatStorage',
    `UPDATE ZWAMESSAGE SET ZMESSAGETYPE = 14, ZTEXT = NULL, Z_OPT = Z_OPT + 1 WHERE Z_PK = 1;
    UPDATE ZWACHATSESSION SET ZCONTACTJID = 'renamed@g.us' WHERE Z_PK = 2;`,
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 4, deleted: 3 });
  assert.deepEqual(
    rows(out, "SELECT messageType, text FROM messages WHERE stanzaId = 'A1'"),
    [{ messageType: 14, text: null }],
  );
  assert.deepEqual(
    rows(out, "SELECT DISTINCT chatJid FROM messages WHERE stanzaId LIKE 'G%'"),
    [{ chatJid: 'renamed@g.us' }],
  );
  whatsapp.exec('chatStorage', 'DELETE FROM ZWAMESSAGE');
  assert.deepEqual(counts(await run.run()).messages, { count: 0, deleted: 7 });
  assert.deepEqual(rows(out, 'SELECT stanzaId FROM messages'), []);
});

test('compact message scans reapply chat and date selection and ignore version-only changes', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const run = await pipeline(
    new WhatsAppDesktopSource(whatsapp.container, {
      collectionIds: [alice],
      startAt: '2026-10-01T00:00:00.000Z',
      endAt: '2026-10-02T00:00:00.000Z',
    }),
    dir.path,
    ({ name }) => name === 'messages',
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 2, deleted: 0 });
  whatsapp.exec('chatStorage', 'UPDATE ZWAMESSAGE SET Z_OPT = Z_OPT + 1');
  assert.deepEqual(counts(await run.run()).messages, { count: 0, deleted: 0 });
  whatsapp.exec(
    'chatStorage',
    `UPDATE ZWAMESSAGE SET ZMESSAGEDATE = ${coreData('2026-10-03T00:00:00.000Z')}, Z_OPT = Z_OPT + 1 WHERE Z_PK = 1;
    UPDATE ZWAMESSAGE SET ZMESSAGEDATE = ${coreData('2026-10-01T12:00:00.000Z')}, Z_OPT = Z_OPT + 1 WHERE Z_PK = 3;`,
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 1, deleted: 1 });
  assert.deepEqual(
    rows(out, 'SELECT stanzaId FROM messages ORDER BY stanzaId'),
    [{ stanzaId: 'A2' }, { stanzaId: 'B1' }],
  );
  whatsapp.exec(
    'chatStorage',
    "UPDATE ZWACHATSESSION SET ZCONTACTJID = 'elsewhere@s.whatsapp.net' WHERE Z_PK = 1",
  );
  assert.deepEqual(counts(await run.run()).messages, { count: 0, deleted: 2 });
});

test('compact message scans keep the last checkpoint after a decode failure and recover on retry', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const open = () =>
    pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
      ({ name }) => name === 'messageReactions',
    );
  await (await open()).run();
  const before = rows(
    join(dir.path, 'state.sqlite'),
    'SELECT state FROM checkpoints',
  );
  const saved = table(out, 'messageReactions', 'reactionStanzaId');
  whatsapp.exec(
    'chatStorage',
    "UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = x'0f', Z_OPT = Z_OPT + 1 WHERE Z_PK = 1",
  );
  await assert.rejects((await open()).run(), PipelineError);
  assert.deepEqual(
    rows(join(dir.path, 'state.sqlite'), 'SELECT state FROM checkpoints'),
    before,
  );
  assert.deepEqual(table(out, 'messageReactions', 'reactionStanzaId'), saved);
  // Keep the failed version: advancing a failed checkpoint would skip this repair.
  whatsapp.exec(
    'chatStorage',
    "UPDATE ZWAMESSAGEINFO SET ZRECEIPTINFO = x'' WHERE Z_PK = 1",
  );
  assert.deepEqual(counts(await (await open()).run()).messageReactions, {
    count: 0,
    deleted: 2,
  });
  assert.deepEqual(table(out, 'messageReactions', 'reactionStanzaId'), []);
});

test('a second run with no change writes nothing; a changed record is written again, and one WhatsApp removed is deleted, with what hung off it', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const source = new WhatsAppDesktopSource(whatsapp.container);
  const run = await pipeline(source, dir.path);
  const { streams } = await source.discover();
  const unchanged = Object.fromEntries(
    streams.map(({ name }) => [name, { count: 0, deleted: 0 }]),
  );
  await run.run();

  assert.deepEqual(counts(await run.run()), unchanged);

  whatsapp.exec(
    'chatStorage',
    `UPDATE ZWAMESSAGE SET ZTEXT = 'Are you still coming?', Z_OPT = Z_OPT + 1 WHERE Z_PK = 1;
     DELETE FROM ZWAMESSAGE WHERE Z_PK = 2;
     DELETE FROM ZWAMESSAGEINFO WHERE Z_PK = 1;`,
  );
  whatsapp.exec('contacts', 'DELETE FROM ZWAADDRESSBOOKCONTACT');
  whatsapp.exec(
    'calls',
    'DELETE FROM ZWACDCALLEVENTPARTICIPANT WHERE Z_PK = 3',
  );
  whatsapp.exec(
    'messageAssociations',
    'DELETE FROM message_parent_association',
  );
  whatsapp.exec('businesses', 'DELETE FROM ZWABIZCATEGORYDATA WHERE Z_PK = 2');
  whatsapp.exec(
    'stickers',
    "DELETE FROM ZWACDSTICKER WHERE ZFILEHASH = 'HASH1'",
  );
  whatsapp.exec(
    'localKeyValue',
    "DELETE FROM ZWAKEYVALUEELEMENT WHERE ZKEY = 'last'",
  );
  whatsapp.exec(
    'backedUpKeyValue',
    "DELETE FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'fs.v2'",
  );

  assert.deepEqual(counts(await run.run()), {
    ...unchanged,
    messages: { count: 1, deleted: 1 },
    messageReceipts: { count: 0, deleted: 3 },
    messageReactions: { count: 0, deleted: 2 },
    contacts: { count: 0, deleted: 1 },
    callParticipants: { count: 0, deleted: 1 },
    messageAssociations: { count: 0, deleted: 1 },
    // The other category moves up to the first place.
    businessCategories: { count: 1, deleted: 1 },
    stickers: { count: 0, deleted: 1 },
    privacySettings: { count: 0, deleted: 1 },
    favoriteStickers: { count: 0, deleted: 1 },
  });
  assert.deepEqual(
    rows(
      out,
      'SELECT "stanzaId", text FROM messages WHERE "chatJid" = \'' +
        alice +
        '\' ORDER BY "stanzaId"',
    ),
    [
      { stanzaId: 'A1', text: 'Are you still coming?' },
      { stanzaId: 'A2', text: 'The plan' },
    ],
  );
  assert.deepEqual(counts(await run.run()), unchanged);
});

test('an import narrowed to chats keeps those chats, their messages and what hangs off them; one narrowed by dates keeps the messages sent within them', async () => {
  const load = async (scope: ImportScope) => {
    const { dir, whatsapp, out } = await scratch();
    await using _ = dir;
    await (
      await pipeline(
        new WhatsAppDesktopSource(whatsapp.container, scope),
        dir.path,
      )
    ).run();
    const read = (sql: string) => rows(out, sql);
    return {
      chats: read('SELECT jid FROM chats ORDER BY jid').map(({ jid }) => jid),
      messages: read('SELECT "stanzaId" FROM messages ORDER BY "stanzaId"').map(
        ({ stanzaId }) => stanzaId,
      ),
      hanging: Object.fromEntries(
        [
          'messageReceipts',
          'messageReactions',
          'messageReactionCounts',
          'messageDataItems',
          'messageAssociations',
          'groupMembers',
          'groupMembersChanges',
          'chatPushConfigs',
          'users',
          'calls',
        ].map((name) => [
          name,
          read(`SELECT count(*) AS n FROM "${name}"`)[0]?.n,
        ]),
      ),
    };
  };

  assert.deepEqual(await load({ collectionIds: [group] }), {
    chats: [group],
    messages: ['G1', 'G2', 'G3'],
    hanging: {
      messageReceipts: 0,
      messageReactions: 0,
      messageReactionCounts: 0,
      messageDataItems: 1,
      messageAssociations: 1,
      groupMembers: 2,
      groupMembersChanges: 1,
      chatPushConfigs: 0,
      users: 2,
      calls: 2,
    },
  });
  assert.deepEqual(
    await load({
      startAt: '2026-10-01T09:30:00.000Z',
      endAt: '2026-10-04T00:00:00.000Z',
    }),
    {
      chats: [
        '120363000000000001@g.us',
        '120363000000000002@newsletter',
        '120363000000000003@g.us',
        alice,
        '1700000000@broadcast',
        '9001@lid.status',
      ],
      messages: ['A2', 'B1', 'G1', 'G2'],
      hanging: {
        messageReceipts: 3,
        messageReactions: 2,
        messageReactionCounts: 0,
        messageDataItems: 0,
        messageAssociations: 0,
        groupMembers: 3,
        groupMembersChanges: 1,
        chatPushConfigs: 2,
        users: 2,
        calls: 2,
      },
    },
  );
});

test('a downloaded photo, a profile picture’s thumbnail and sticker files load as files, and media this Mac never downloaded loads without one', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;

  await (
    await pipeline(new WhatsAppDesktopSource(whatsapp.container), dir.path)
  ).run();

  const file = async (reference: unknown) =>
    typeof reference === 'string'
      ? readFile(join(dir.path, 'files', reference), 'utf8')
      : null;
  const files = async (sql: string) =>
    Promise.all(
      rows(out, sql).map(async ({ key, attachmentRef }) => [
        key,
        await file(attachmentRef),
      ]),
    );
  assert.deepEqual(
    await files(
      'SELECT "stanzaId" AS key, "attachmentRef" FROM messages ORDER BY "stanzaId"',
    ),
    [
      ['A1', null],
      ['A2', null],
      ['B1', null],
      ['G1', 'jpeg'],
      ['G2', null],
      ['G3', null],
      ['N1', null],
    ],
  );
  assert.deepEqual(
    await files(
      'SELECT jid AS key, "attachmentRef" FROM "profilePictures" ORDER BY jid',
    ),
    [
      [aliceLid, 'alice thumbnail'],
      [bobLid, null],
    ],
  );
  assert.deepEqual(
    await files(
      'SELECT "fileHash" AS key, "attachmentRef" FROM stickers ORDER BY "fileHash"',
    ),
    [
      ['HASH1', 'sticker one'],
      ['HASH2', 'sticker two'],
      ['HASH3', null],
    ],
  );
  assert.deepEqual(
    await files(
      'SELECT uuid AS key, "attachmentRef" FROM statuses ORDER BY uuid',
    ),
    [
      ['S-OLD', null],
      ['S-PHOTO', 'status photo'],
      ['S-TEXT', null],
    ],
  );
});

// A watch that ignores its signal would never end; the timeout fails it
// instead of hanging the suite.
test(
  'a WhatsApp watch wakes each stream once, then only the streams of a store WhatsApp committed to, including a store it creates later',
  { timeout: 30_000 },
  async () => {
    const { dir, whatsapp } = await scratch();
    await using _ = dir;
    removeStore(whatsapp, 'businesses');
    const source = new WhatsAppDesktopSource(whatsapp.container);
    const streams = [
      source.messages,
      source.contacts,
      source.businessProfiles,
      source.privacySettings,
    ];
    // WhatsApp holds its connections, and so its WALs, open while it runs.
    using chats = new DatabaseSync(whatsapp.path('chatStorage'));
    using contacts = new DatabaseSync(whatsapp.path('contacts'));
    const controller = new AbortController();
    const woken: string[][] = [];

    for await (const batch of source.watch({
      streams,
      // A batch that never comes ends the watch, so the assertion fails.
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })) {
      woken.push(batch.map((stream) => stream.name));
      if (woken.length === 1)
        contacts.exec(
          "UPDATE ZWAADDRESSBOOKCONTACT SET ZABOUTTEXT = 'Free' WHERE Z_PK = 1",
        );
      else if (woken.length === 2)
        chats.exec(
          "UPDATE ZWAMESSAGE SET ZTEXT = 'Edited', Z_OPT = Z_OPT + 1 WHERE Z_PK = 1",
        );
      else if (woken.length === 3) whatsapp.create('businesses');
      else controller.abort();
    }

    assert.deepEqual(woken, [
      ['messages', 'contacts', 'businessProfiles', 'privacySettings'],
      ['contacts'],
      ['messages'],
      ['businessProfiles'],
    ]);
  },
);

// This Mac's own WhatsApp, read-only: each store loads every stream it
// feeds, as many rows as the store holds. Nothing is kept outside a
// temporary folder, and no content is printed: it is the user's.
test('this Mac’s WhatsApp loads every stream of each store it holds', async (t) => {
  if (process.platform !== 'darwin') return t.skip('WhatsApp runs on macOS');
  // What each stream should count, read straight from its store: the keys
  // the reader keeps, one per record.
  const expected: Record<Store, [string, string][]> = {
    chatStorage: [
      ['chats', 'SELECT count(DISTINCT ZCONTACTJID) AS n FROM ZWACHATSESSION'],
      [
        'messages',
        'SELECT count(*) AS n FROM (SELECT DISTINCT chat.ZCONTACTJID, message.ZISFROMME, message.ZSTANZAID FROM ZWAMESSAGE AS message JOIN ZWACHATSESSION AS chat ON chat.Z_PK = message.ZCHATSESSION)',
      ],
      [
        'groupMembers',
        'SELECT count(*) AS n FROM ZWAGROUPMEMBER AS member JOIN ZWACHATSESSION AS chat ON chat.Z_PK = member.ZCHATSESSION',
      ],
      [
        'groupMembersChanges',
        'SELECT count(*) AS n FROM ZWAGROUPMEMBERSCHANGE',
      ],
      [
        'messageDataItems',
        'SELECT count(*) AS n FROM ZWAMESSAGEDATAITEM AS item JOIN ZWAMESSAGE AS message ON message.Z_PK = item.ZMESSAGE JOIN ZWACHATSESSION AS chat ON chat.Z_PK = message.ZCHATSESSION',
      ],
      ['pushNames', 'SELECT count(*) AS n FROM ZWAPROFILEPUSHNAME'],
      ['profilePictures', 'SELECT count(*) AS n FROM ZWAPROFILEPICTUREITEM'],
      ['blockedContacts', 'SELECT count(*) AS n FROM ZWABLACKLISTITEM'],
      ['chatPushConfigs', 'SELECT count(*) AS n FROM ZWACHATPUSHCONFIG'],
    ],
    contacts: [['contacts', 'SELECT count(*) AS n FROM ZWAADDRESSBOOKCONTACT']],
    users: [['users', 'SELECT count(*) AS n FROM ZWAZACCOUNT']],
    calls: [['calls', 'SELECT count(*) AS n FROM ZWACDCALLEVENT']],
    messageAssociations: [
      [
        'messageAssociations',
        'SELECT count(*) AS n FROM message_parent_association',
      ],
    ],
    businesses: [
      ['businessProfiles', 'SELECT count(*) AS n FROM ZWABIZPROFILEDATA'],
      [
        'businessVerifiedNames',
        'SELECT count(*) AS n FROM ZWABIZVERIFIEDNAMEDATA',
      ],
      ['businessCategories', 'SELECT count(*) AS n FROM ZWABIZCATEGORYDATA'],
      [
        'businessServiceAreas',
        'SELECT count(*) AS n FROM ZWABIZSERVICEAREADATA',
      ],
    ],
    statuses: [['statuses', 'SELECT count(*) AS n FROM status']],
    stickers: [
      ['stickers', 'SELECT count(*) AS n FROM ZWACDSTICKER'],
      [
        'stickerPacks',
        "SELECT count(*) AS n FROM ZWACDABSTRACTSTICKERPACK WHERE Z_ENT IN (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME IN ('WACDStickerPack', 'WACDStoreStickerPack'))",
      ],
    ],
    localKeyValue: [
      [
        'privacySettings',
        "SELECT count(*) AS n FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'privacy-settings-values'",
      ],
      [
        'disappearingModes',
        "SELECT count(*) AS n FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'disappearing-mode'",
      ],
      [
        'changedNumbers',
        "SELECT count(*) AS n FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'changenumber-oldtonew'",
      ],
    ],
    backedUpKeyValue: [
      [
        'favoriteStickers',
        "SELECT count(*) AS n FROM ZWAKEYVALUEELEMENT WHERE ZNAMESPACE = 'fs.v2'",
      ],
    ],
  };
  for (const store of allStores)
    await t.test(store, async (s) => {
      await using dir = await mkdtempDisposable(
        join(tmpdir(), 'elt-whatsapp-live-'),
      );
      const source = new WhatsAppDesktopSource();
      const path = join(whatsappContainer, stores[store].file);
      // data_version changes when another connection commits, as seen by
      // one connection held open, so this one stays open across the read.
      let commits: DatabaseSync | undefined;
      try {
        commits = new DatabaseSync(path, { readOnly: true });
      } catch {
        commits = undefined;
      }
      using _ = { [Symbol.dispose]: () => commits?.close() };
      const version = () =>
        commits?.prepare('PRAGMA data_version').get()?.data_version;
      const before = version();
      const run = await pipeline(source, dir.path, ({ name }) =>
        streamsOf[store].includes(name),
      );
      try {
        await run.run();
      } catch (error) {
        const { errors } = failures(error);
        if (
          errors.length > 0 &&
          errors.every((cause) => cause instanceof WhatsAppUnavailableError)
        )
          return s.skip(`no access to ${stores[store].file}`);
        throw error;
      }
      const held = expected[store].map(([stream, sql]) => [
        stream,
        commits?.prepare(sql).get()?.n,
      ]);
      if (version() !== before)
        return s.skip('WhatsApp wrote while the store was read');
      assert.deepEqual(
        expected[store].map(([stream]) => [
          stream,
          rows(
            join(dir.path, 'out.sqlite'),
            `SELECT count(*) AS n FROM "${stream}"`,
          )[0]?.n,
        ]),
        held,
      );
    });
});

test('statuses load with their text styling and photo; one that vanishes within its day is deleted, and one WhatsApp drops after it stays', async () => {
  const { dir, whatsapp, out } = await scratch();
  await using _ = dir;
  const source = new WhatsAppDesktopSource(whatsapp.container);
  const run = await pipeline(
    source,
    dir.path,
    ({ name }) => name === 'statuses',
  );

  await run.run();

  const plain = {
    serverReceiptTimestamp: null,
    receivedTimestamp: null,
    state: 4,
    origin: 0,
    flags: 0,
    isArchived: 0,
    audienceType: 0,
    url: null,
    pageTitle: null,
    pageDescription: null,
    fontStyle: null,
    textColor: null,
    backgroundColor: null,
    previewType: null,
    mimeType: null,
    width: null,
    height: null,
    fileSize: null,
    mediaDuration: null,
    accessibilityLabel: null,
    fileHash: null,
    filePath: null,
    mediaAvailableLocally: 0,
  };
  assert.deepEqual(
    table(out, 'statuses', 'sortId').map(({ attachmentRef, ...row }) => row),
    [
      {
        ...plain,
        senderJid: aliceLid,
        uuid: 'S-PHOTO',
        type: 4,
        sortId: 1,
        timestamp: hoursAgo(2).toISOString(),
        serverReceiptTimestamp: hoursAgo(2).toISOString(),
        receivedTimestamp: hoursAgo(1).toISOString(),
        text: 'At the beach',
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1920,
        fileSize: 12,
        accessibilityLabel: 'A beach',
        fileHash: 'c3RhdHVz',
        filePath: 'Media/9001@lid/s/t/status.jpg',
        mediaAvailableLocally: 1,
      },
      {
        ...plain,
        senderJid: aliceLid,
        uuid: 'S-TEXT',
        type: 10,
        sortId: 2,
        timestamp: hoursAgo(22).toISOString(),
        text: 'Read this https://news.example',
        url: 'https://news.example',
        pageTitle: 'News',
        pageDescription: 'Today’s news',
        fontStyle: 2,
        textColor: -1,
        backgroundColor: -16777216,
        previewType: 1,
      },
      {
        ...plain,
        senderJid: bobLid,
        uuid: 'S-OLD',
        type: 10,
        sortId: 3,
        timestamp: hoursAgo(26).toISOString(),
        text: 'Yesterday',
      },
    ],
  );

  // Alice withdraws her text status within its day; WhatsApp drops Bob's,
  // past its day.
  whatsapp.exec('statuses', 'DELETE FROM status WHERE row_id IN (2, 3)');

  assert.deepEqual(counts(await run.run()), {
    statuses: { count: 0, deleted: 1 },
  });
  assert.deepEqual(
    rows(out, 'SELECT uuid FROM statuses ORDER BY uuid').map(
      ({ uuid }) => uuid,
    ),
    ['S-OLD', 'S-PHOTO'],
  );
});

test('a value WhatsApp always stores but left empty fails the streams read from it, rather than reading as zero or empty', async () => {
  const breaks: [string, Store, string, string[], RegExp][] = [
    [
      'a chat with no kind',
      'chatStorage',
      'UPDATE ZWACHATSESSION SET ZSESSIONTYPE = NULL WHERE Z_PK = 3',
      ['chats'],
      /no session type/,
    ],
    [
      'a message with no type',
      'chatStorage',
      'UPDATE ZWAMESSAGE SET ZMESSAGETYPE = NULL, Z_OPT = Z_OPT + 1 WHERE Z_PK = 1',
      [
        'messageReactionCounts',
        'messageReactions',
        'messageReceipts',
        'messages',
      ],
      /message has no type/,
    ],
    [
      'a privacy setting with no value',
      'localKeyValue',
      "UPDATE ZWAKEYVALUEELEMENT SET ZVALUE = NULL WHERE ZNAMESPACE = 'privacy-settings-values'",
      ['privacySettings'],
      /privacy-settings-values entry has no value/,
    ],
    ...['ZWAMESSAGE', 'ZWAMEDIAITEM', 'ZWAMESSAGEINFO'].map(
      (table): [string, Store, string, string[], RegExp] => [
        `${table} without its row version`,
        'chatStorage',
        `UPDATE ${table} SET Z_OPT = NULL WHERE Z_PK = 1`,
        [
          'messageReactionCounts',
          'messageReactions',
          'messageReceipts',
          'messages',
        ],
        /message input has no row version/,
      ],
    ),
  ];
  for (const [what, store, sql, failed, named] of breaks) {
    const broken = await failedAfter((whatsapp) => whatsapp.exec(store, sql));
    assert.deepEqual(broken.streams, failed, what);
    for (const error of broken.errors) assert.match(String(error), named, what);
  }
});

test('large WhatsApp passes stream payloads and reuse compact metadata within a small heap', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'elt-whatsapp-large-'),
  );
  const whatsapp = new ScratchWhatsApp(join(directory.path, 'container'));
  whatsapp.exec(
    'chatStorage',
    `INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, ZCONTACTJID, ZSESSIONTYPE, ZPARTNERNAME)
       VALUES (1, 4, '${alice}', 0, 'Alice');
     WITH RECURSIVE message(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM message WHERE n < 60000
     )
     INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZCHATSESSION, ZISFROMME, ZSTANZAID, ZFROMJID, ZMESSAGEDATE, ZMESSAGETYPE, ZMESSAGESTATUS, ZTEXT)
       SELECT n, 9, 1, 1, n % 2, 'stanza-' || n, '${alice}', 780000000 + n, 0, 6, 'message ' || n || ' ' || hex(randomblob(40))
       FROM message;`,
  );
  // Retaining full metadata objects passes the initial import but exhausts
  // this heap on repeat; compact metadata must fit alongside checkpoints.
  // Load the built source where its workspace dependencies resolve.
  const pass = `
    const { Connection, Copy, Pipeline } = await import('@workspace/elt');
    const { SQLiteCheckpointStore, SQLiteDestination, SQLiteSyncHistory } = await import('@workspace/elt-sqlite');
    const { WhatsAppDesktopSource } = await import(process.env.SOURCE);
    const source = new WhatsAppDesktopSource(process.env.CONTAINER);
    const destination = new SQLiteDestination({ path: process.env.OUT + '/data.sqlite' });
    const { streams } = await source.discover();
    const history = new SQLiteSyncHistory();
    await history.install([destination]);
    const pipeline = new Pipeline({
      history,
      connections: [
        new Connection({
          name: 'whatsapp',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({ path: process.env.OUT + '/checkpoints.sqlite' }),
          steps: streams.map((stream) => new Copy(stream, destination.table('raw_' + stream.name), {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          })),
        }),
      ],
    });
    await pipeline.run();
    const repeated = await pipeline.run();
    if (repeated.some(({ count, deleted }) => count !== 0 || deleted !== 0)) throw new Error('An unchanged pass wrote rows');
  `;

  const run = spawnSync(
    process.execPath,
    ['--max-old-space-size=64', '--input-type=module', '-e', pass],
    {
      // The package's own folder, where its dependencies resolve.
      cwd: join(import.meta.dirname, '..'),
      env: {
        ...process.env,
        SOURCE: pathToFileURL(
          join(import.meta.dirname, 'whatsapp-desktop-source.js'),
        ).href,
        CONTAINER: whatsapp.container,
        OUT: directory.path,
      },
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  // V8 names a heap limit it reached in the first lines it writes.
  assert.equal(
    run.status,
    0,
    `${run.signal ?? ''} ${run.error?.message ?? ''}\n${run.stderr.slice(0, 1000)}`,
  );
  using imported = new DatabaseSync(join(directory.path, 'data.sqlite'), {
    readOnly: true,
  });
  assert.deepEqual(
    { ...imported.prepare('SELECT count(*) AS n FROM raw_messages').get() },
    { n: 60_000 },
  );
});

test('message streams reuse one completed metadata scan and refresh file availability on the next pass', async () => {
  const { dir, whatsapp } = await scratch();
  await using _ = dir;
  const source = new WhatsAppDesktopSource(whatsapp.container);
  // Start with a derived stream: sharing must not depend on selecting messages first.
  const selected = [
    source.messageReactionCounts,
    source.messages,
    source.messageReceipts,
    source.messageReactions,
  ];
  const catalog = selected.map(
    (stream) =>
      new CopyConfiguration(stream, {
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
      }),
  );
  const states = new Map<string, unknown>();
  const fingerprints = (state: unknown) => {
    const groups = JSON.parse(JSON.stringify(state)).groups;
    return Object.fromEntries(
      Object.keys(groups).map((key) => [key, groups[key].fingerprint]),
    );
  };
  const first: unknown[] = [];
  for await (const message of source.read(catalog, states)) {
    if (message instanceof StreamStatus)
      assert.notEqual(message.status, 'FAILED');
    else if ('type' in message && message.type === 'STATE') {
      first.push(fingerprints(message.state));
      states.set(message.stream, message.state);
      // SQLite stays pinned, but files can change between streams. Their saved
      // fingerprints reveal a repeated native scan without mocking the SDK.
      if (first.length === 1)
        rmSync(
          join(
            whatsapp.container,
            'Message/Media/120363000000000001@g.us/a/b/photo.jpg',
          ),
        );
    }
  }
  assert.equal(first.length, 4);
  for (const snapshot of first) assert.deepEqual(snapshot, first[0]);
  const next: unknown[] = [];
  for await (const message of source.read(catalog, states)) {
    if (message instanceof StreamStatus)
      assert.notEqual(message.status, 'FAILED');
    else if ('type' in message && message.type === 'STATE')
      next.push(fingerprints(message.state));
  }
  assert.equal(next.length, 4);
  for (const snapshot of next) assert.deepEqual(snapshot, next[0]);
  assert.notDeepEqual(next[0], first[0]);
});

test('shared metadata respects combined chat and date scopes, empty scopes and derived-only selections', async () => {
  for (const [scope, ids, hanging] of [
    [
      {
        collectionIds: [group],
        startAt: '2026-10-04T09:00:00.000Z',
        endAt: '2026-10-05T00:00:00.000Z',
      },
      ['7'],
      1,
    ],
    [
      {
        collectionIds: [group],
        startAt: '2026-10-03T08:00:00.000Z',
        endAt: '2026-10-04T09:00:00.000Z',
      },
      ['4', '6'],
      0,
    ],
    [{ collectionIds: [] }, [], 0],
  ] satisfies [ImportScope, string[], number][]) {
    const { dir, whatsapp, out } = await scratch();
    await using _ = dir;
    const selected = new Set([
      'messageReceipts',
      'messageReactions',
      'messageReactionCounts',
      'messageDataItems',
      'messageAssociations',
    ]);
    const run = await pipeline(
      new WhatsAppDesktopSource(whatsapp.container, scope),
      dir.path,
      ({ name }) => selected.has(name),
    );
    await run.run();
    for (const { id, state } of rows(
      join(dir.path, 'state.sqlite'),
      'SELECT id, state FROM checkpoints',
    )) {
      if (
        [
          'messageReceipts',
          'messageReactions',
          'messageReactionCounts',
        ].includes(String(id))
      ) {
        assert.deepEqual(Object.keys(JSON.parse(String(state)).groups), ids);
      }
    }
    for (const name of ['messageDataItems', 'messageAssociations'])
      assert.equal(
        rows(out, 'SELECT count(*) AS n FROM "' + name + '"')[0]?.n,
        hanging,
      );
    assert.deepEqual(
      counts(await run.run()),
      Object.fromEntries(
        [...selected].map((name) => [name, { count: 0, deleted: 0 }]),
      ),
    );
  }
});

test('cancelling a metadata build or replay publishes no partial checkpoint and a fresh read recovers', async () => {
  for (const cancelAt of ['messages', 'messageReceipts']) {
    const { dir, whatsapp } = await scratch();
    await using _ = dir;
    const source = new WhatsAppDesktopSource(whatsapp.container);
    const catalog = [
      source.messages,
      source.messageReceipts,
      source.messageReactions,
      source.messageReactionCounts,
    ].map(
      (stream) =>
        new CopyConfiguration(stream, {
          syncMode: 'incremental',
          destinationSyncMode: 'append_dedup',
        }),
    );
    const controller = new AbortController();
    const reason = new Error('Stop the metadata pass');
    const committed: string[] = [];
    const failed: string[] = [];
    for await (const message of source.read(
      catalog,
      new Map(),
      controller.signal,
    )) {
      if (message instanceof StreamStatus) {
        if (message.status === 'FAILED') {
          assert.equal(message.error, reason);
          failed.push(message.stream);
        }
      } else if ('type' in message) {
        if (message.type === 'STATE') committed.push(message.stream);
      } else if (message.stream === cancelAt) controller.abort(reason);
    }
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(committed, cancelAt === 'messages' ? [] : ['messages']);
    assert.deepEqual(
      failed,
      catalog.slice(committed.length).map(({ stream }) => stream.name),
    );
    const recovered = new Map<string, number>();
    for await (const message of source.read(catalog, new Map())) {
      if (message instanceof StreamStatus)
        assert.notEqual(message.status, 'FAILED');
      else if ('type' in message && message.type === 'STATE')
        recovered.set(
          message.stream,
          Object.keys(JSON.parse(JSON.stringify(message.state)).groups).length,
        );
    }
    assert.deepEqual(
      [...recovered],
      catalog.map(({ stream }) => [stream.name, 7]),
    );
    // Closing the consumer early also closes the underlying SQLite iterators.
    for await (const message of source.read(catalog, new Map())) {
      if (!(message instanceof StreamStatus) && !('type' in message)) break;
    }
    using database = new DatabaseSync(whatsapp.path('chatStorage'));
    assert.equal(
      database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()?.busy,
      0,
    );
  }
});

test('a failed metadata scan or payload leaves every affected checkpoint intact and retries from the beginning', async () => {
  for (const column of ['Z_OPT', 'ZMESSAGETYPE']) {
    const { dir, whatsapp, out } = await scratch();
    await using _ = dir;
    const selected = new Set([
      'messages',
      'messageReceipts',
      'messageReactions',
      'messageReactionCounts',
    ]);
    const run = await pipeline(
      new WhatsAppDesktopSource(whatsapp.container),
      dir.path,
      ({ name }) => selected.has(name),
    );
    await run.run();
    const checkpoints = () =>
      rows(
        join(dir.path, 'state.sqlite'),
        'SELECT id, state FROM checkpoints ORDER BY id',
      );
    const saved = checkpoints();
    const original = table(out, 'messages', 'stanzaId');
    // Fail after a valid prefix; accepting that prefix would delete later groups.
    whatsapp.exec(
      'chatStorage',
      "UPDATE ZWAMESSAGE SET ZTEXT = 'Retry this edit', Z_OPT = Z_OPT + 1 WHERE Z_PK = 1; UPDATE ZWAMESSAGE SET Z_OPT = Z_OPT + 1 WHERE Z_PK = 6; UPDATE ZWAMESSAGE SET " +
        column +
        ' = NULL WHERE Z_PK = 6',
    );
    await assert.rejects(run.run(), (error) => {
      assert.deepEqual(failures(error).streams, [...selected].sort());
      return true;
    });
    assert.deepEqual(checkpoints(), saved);
    assert.deepEqual(table(out, 'messages', 'stanzaId'), original);
    whatsapp.exec(
      'chatStorage',
      'UPDATE ZWAMESSAGE SET ' +
        column +
        ' = ' +
        (column === 'Z_OPT' ? 2 : 6) +
        ' WHERE Z_PK = 6',
    );
    assert.deepEqual(
      counts(await run.run()),
      Object.fromEntries(
        [...selected].map((name) => [
          name,
          { count: name === 'messages' ? 1 : 0, deleted: 0 },
        ]),
      ),
    );
    assert.deepEqual(
      rows(out, "SELECT text FROM messages WHERE stanzaId = 'A1'"),
      [{ text: 'Retry this edit' }],
    );
  }
});
