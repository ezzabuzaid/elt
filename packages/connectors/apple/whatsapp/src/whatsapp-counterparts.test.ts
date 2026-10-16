import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { Settings } from '@workspace/settings';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

// The SDK finds WhatsApp's container under HOME when its module loads, so the
// connector is imported only after HOME points at the test's folder. node
// --test runs this file in its own process, so the module loads once.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: WhatsAppConnector } =
      await import('./whatsapp-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // WhatsApp reads nothing through EventKit.
    return new WhatsAppConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

// One pass as the hosts run it, from a saved selection into its import.
async function importScope(
  connector: AppleConnector,
  root: string,
  scope: ImportScope,
): Promise<string> {
  using settings = new Settings(root);
  const selection = {
    connector: connector.name,
    scope,
    includeAttachments: false,
  };
  settings.select([selection], {
    facts: () => connector,
    permissions: () => connector.guidance(),
  });
  const outcome = await connector.import(settings, selection);
  assert.deepEqual(outcome, { status: 'imported' });
  return settings.database(selection);
}

// Reads as query-apple tells the agent to: the macOS sqlite3 shell,
// read-only. A failing statement fails the test rather than reading as no rows.
function read(database: string, sql: string): Record<string, unknown>[] {
  const result = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', '-cmd', '.timeout 30000', database, sql],
    { encoding: 'utf8' },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout || '[]');
}

// Each store's tables the reader reads, as WhatsApp 26.38's models create
// them, by the store's file in the container.
const schemas = {
  'ChatStorage.sqlite': `
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
  'ContactsV2.sqlite': `
    CREATE TABLE ZWAADDRESSBOOKCONTACT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDISAPPEARINGMODEDURATION INTEGER, ZPHONESTATUS INTEGER, ZSECTIONSORT INTEGER, ZSORT INTEGER, ZSOURCE INTEGER, ZSPOTLIGHTSTATUS INTEGER, ZSYNCPOLICY INTEGER, ZSYNCWITHSERVERSTATE INTEGER, ZABOUTEXPIRATIONTIMESTAMP TIMESTAMP, ZABOUTTIMESTAMP TIMESTAMP, ZDISAPPEARINGMODETIMESTAMP TIMESTAMP, ZLASTUPDATED TIMESTAMP, ZABOUTEMOJI VARCHAR, ZABOUTTEXT VARCHAR, ZBUSINESSNAME VARCHAR, ZFULLNAME VARCHAR, ZGIVENNAME VARCHAR, ZHIGHLIGHTEDNAME VARCHAR, ZIDENTIFIER VARCHAR, ZINTEROPJID VARCHAR, ZLASTNAME VARCHAR, ZLID VARCHAR, ZLIDHASH VARCHAR, ZLOCALIZEDPHONENUMBER VARCHAR, ZNOTES VARCHAR, ZPHONENUMBER VARCHAR, ZPHONENUMBERLABEL VARCHAR, ZPNHASH VARCHAR, ZSEARCHTOKENLIST VARCHAR, ZSECTIONTITLE VARCHAR, ZUNIQUEID VARCHAR, ZUSERNAME VARCHAR, ZWHATSAPPID VARCHAR, ZDEVICELIST BLOB );
  `,
  'LID.sqlite': `
    CREATE TABLE ZWAZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCURRENTPHONENUMBERSHARINGSTATE INTEGER, ZSTATE INTEGER, ZUSERTYPE INTEGER, ZUSERNAMESTATE INTEGER, ZCREATEDAT TIMESTAMP, ZCOUNTRYCODE VARCHAR, ZDISPLAYNAME VARCHAR, ZIDENTIFIER VARCHAR, ZPHONENUMBER VARCHAR, ZUSERNAME VARCHAR, ZADDITIONALDATA BLOB );
  `,
  'CallHistory.sqlite': `
    CREATE TABLE ZWAAGGREGATECALLEVENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINCOMING INTEGER, ZMISSED INTEGER, ZMISSEDREASON INTEGER, ZVIDEO INTEGER, ZFIRSTDATE TIMESTAMP, ZLINKTOKEN VARCHAR );
    CREATE TABLE ZWACDCALLEVENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZBYTESRECEIVED INTEGER, ZBYTESSENT INTEGER, ZISBOTGROUPCALL INTEGER, ZISLIGHTWEIGHT INTEGER, ZOUTCOME INTEGER, Z1CALLEVENTS INTEGER, Z_FOK_1CALLEVENTS INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZCALLIDSTRING VARCHAR, ZGROUPCALLCREATORUSERJIDSTRING VARCHAR, ZGROUPJIDSTRING VARCHAR, ZREMINDERID VARCHAR, ZSCHEDULEDID VARCHAR );
    CREATE TABLE ZWACDCALLEVENTPARTICIPANT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOUTCOME INTEGER, Z1PARTICIPANTS INTEGER, Z_FOK_1PARTICIPANTS INTEGER, ZJIDSTRING VARCHAR );
  `,
  'ExtChatDB/ExtChatDatabase.sqlite': `
    CREATE TABLE message_parent_association( stanza_id TEXT NOT NULL, parent_stanza_id TEXT NOT NULL, type INTEGER NOT NULL, sort LONG_INT NOT NULL, chat_jid TEXT NOT NULL, PRIMARY KEY (stanza_id, chat_jid, type) );
  `,
  'Biz/Biz.sqlite': `
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
  'statusDB/Status.sqlite': `
    CREATE TABLE status( row_id INTEGER PRIMARY KEY AUTOINCREMENT, sort_id LONG_INT NOT NULL, uuid TEXT NOT NULL, sender_user_jid TEXT NOT NULL, status_info_row_id INTEGER NOT NULL, type INTEGER NOT NULL, timestamp LONG_INT NOT NULL, server_receipt_timestamp LONG_INT, text_data TEXT, state INTEGER NOT NULL, secret BLOB, content_proto BLOB, fp_proto BLOB, origin INTEGER NOT NULL, flags INTEGER NOT NULL, is_archived INTEGER NOT NULL , audience_type INTEGER NOT NULL DEFAULT 0, stanza_xml BLOB, received_timestamp LONG_INT, batch_state INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE status_text( status_row_id INTEGER PRIMARY KEY, url TEXT, page_title TEXT, page_description TEXT, font_style INTEGER, text_color INTEGER, background_color INTEGER, preview_type INTEGER, invite_link_group_type INTEGER, thumbnail BLOB, text_content_proto BLOB );
    CREATE TABLE status_media_link( row_id INTEGER PRIMARY KEY AUTOINCREMENT, status_row_id INTEGER NOT NULL, media_content_row_id INTEGER NOT NULL );
    CREATE TABLE media_content( row_id INTEGER PRIMARY KEY AUTOINCREMENT, state INTEGER NOT NULL, transcoded INTEGER NOT NULL, file_path TEXT, suspicious_content INTEGER NOT NULL, width INTEGER, height INTEGER, file_size INTEGER, file_length INTEGER, media_duration INTEGER, media_key BLOB, media_key_timestamp LONG_INT, partial_media_hash TEXT, partial_media_enc_hash TEXT, file_hash TEXT, enc_file_hash TEXT, direct_path TEXT, static_url TEXT, sidecar BLOB, chunk_lengths BLOB, auto_upload_download INTEGER NOT NULL, media_job_uuid TEXT, mime_type TEXT, gif_attribution INTEGER NOT NULL, trim_from INTEGER, trim_to INTEGER, mute_video INTEGER DEFAULT 0, accessibility_label TEXT, media_transcode_quality INTEGER NOT NULL DEFAULT 0, multicast_id TEXT, media_url TEXT, media_name TEXT, original_file_hash TEXT, media_source_type INTEGER, doodle_id TEXT , media_upload_handle TEXT, smart_thumbnail_ts INTEGER);
  `,
  'Sticker.sqlite': `
    CREATE TABLE ZWACDABSTRACTSTICKERPACK ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILESIZE INTEGER, ZORDER INTEGER, ZSTICKERCOUNT INTEGER, ZFLAGS INTEGER, ZTRAYFILELENGTH INTEGER, ZFLAGS1 INTEGER, ZPREMIUMSTICKERCOUNT INTEGER, ZDOWNLOADEDSTICKERPACK INTEGER, ZTRAYMEDIAKEYTIMESTAMP TIMESTAMP, ZIMAGEDATAHASH VARCHAR, ZNAME VARCHAR, ZPACKDESCRIPTION VARCHAR, ZPUBLISHER VARCHAR, ZSTICKERPACKID VARCHAR, ZTRAYIMAGEID VARCHAR, ZTRAYDIRECTPATH VARCHAR, ZTRAYENCFILEHASH VARCHAR, ZTRAYFILEHASH VARCHAR, ZTRAYIMAGEFILEPATH VARCHAR, ZTRAYMIMETYPE VARCHAR, ZTRAYURL VARCHAR, ZPREVIEWIMAGEIDS BLOB, ZTRAYMEDIAKEY BLOB );
    CREATE TABLE ZWACDSTICKER ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILELENGTH INTEGER, ZFLAGS INTEGER, ZHEIGHT INTEGER, ZSORT INTEGER, ZWIDTH INTEGER, ZSTICKERPACK INTEGER, ZMEDIAKEYTIMESTAMP TIMESTAMP, ZACCESSIBILITYTEXT VARCHAR, ZDIRECTPATH VARCHAR, ZEMOJIS VARCHAR, ZENCFILEHASH VARCHAR, ZFILEHASH VARCHAR, ZIMAGEHASH VARCHAR, ZMIMETYPE VARCHAR, ZRELATIVEIMAGEPATH VARCHAR, ZSALTEDFILEHASH VARCHAR, ZSOCIALFBIDSLIST VARCHAR, ZTEMPLATEID VARCHAR, ZURL VARCHAR, ZMEDIAKEY BLOB );
    CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
    INSERT INTO Z_PRIMARYKEY VALUES (1, 'WACDAbstractStickerPack', 0, 0), (2, 'WACDStickerPack', 1, 0), (3, 'WACDStoreStickerPack', 1, 0), (4, 'WACDSticker', 0, 0);
  `,
  'LocalKeyValue.sqlite': `
    CREATE TABLE ZWAKEYVALUEELEMENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZVERSION INTEGER, ZDATE TIMESTAMP, ZKEY VARCHAR, ZNAMESPACE VARCHAR, ZVALUE BLOB );
  `,
  'BackedUpKeyValue.sqlite': `
    CREATE TABLE ZWAKEYVALUEELEMENT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZVERSION INTEGER, ZDATE TIMESTAMP, ZKEY VARCHAR, ZNAMESPACE VARCHAR, ZVALUE BLOB );
  `,
};

type Rows = Record<
  string,
  Record<string, readonly Record<string, SQLInputValue>[]>
>;

// WhatsApp's group container with every store, in WAL mode as WhatsApp keeps
// them, holding rows by store file and table: an import publishes its views
// once every stream it copies has loaded.
function whatsappUnder(home: string, rows: Rows): void {
  const container = join(
    home,
    'Library/Group Containers/group.net.whatsapp.WhatsApp.shared',
  );
  for (const [file, schema] of Object.entries(schemas)) {
    mkdirSync(dirname(join(container, file)), { recursive: true });
    using database = new DatabaseSync(join(container, file));
    database.exec(`PRAGMA journal_mode = WAL; ${schema}`);
  }
  for (const [file, tables] of Object.entries(rows)) {
    using database = new DatabaseSync(join(container, file));
    for (const [table, list] of Object.entries(tables))
      for (const row of list) {
        const columns = Object.keys(row);
        database
          .prepare(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
          )
          .run(...Object.values(row));
      }
  }
}

// Core Data stores a date as seconds since 2001-01-01 UTC.
const coreData = (iso: string) => Date.parse(iso) / 1000 - 978307200;

// A protobuf as WhatsApp writes a message's receipt info: varints, and bytes
// or nested messages.
type ProtobufFields = readonly (readonly [
  number,
  number | Uint8Array | ProtobufFields,
])[];

function protobuf(fields: ProtobufFields): Uint8Array {
  const bytes: number[] = [];
  const varint = (value: number) => {
    let rest = value;
    while (rest >= 0x80) {
      bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
  };
  for (const [number, value] of fields) {
    if (typeof value === 'number') {
      varint(number * 8);
      varint(value);
      continue;
    }
    const content = value instanceof Uint8Array ? value : protobuf(value);
    varint(number * 8 + 2);
    varint(content.length);
    bytes.push(...content);
  }
  return Uint8Array.from(bytes);
}

// A receipt's recipient as WhatsApp packs it: the server's byte (0x81 a
// phone number, 0x8c a LID), then the number in binary-coded decimal padded
// with an F nibble.
function packedJid(server: number, user: string): Uint8Array {
  const digits = user.length % 2 === 0 ? user : `${user}f`;
  return Uint8Array.from([server, ...Buffer.from(digits, 'hex')]);
}

// The receipts WhatsApp keeps on a message sent at the given time, each a
// recipient and the seconds after it until their device received it.
function receipts(
  sentAt: string,
  recipients: readonly (readonly [Uint8Array, number])[],
): Uint8Array {
  return protobuf([
    [3, Date.parse(sentAt) / 1000],
    ...recipients.map(
      ([jid, delivered]) =>
        [
          2,
          [
            [1, jid],
            [4, delivered],
          ],
        ] as const,
    ),
  ]);
}

const alice = '15550001001@s.whatsapp.net';
const bob = '9002@lid';
const carol = '9003@lid';
const group = '120363000000000001@g.us';

// Bob's number as WhatsApp titles a person missing from the address book:
// between direction marks, with a no-break space and hyphen.
const bobsNumber = '\u202a+1 555\u00a0000\u20112002\u202c';

const chat = (pk: number, jid: string, kind: number, title: string | null) => ({
  Z_PK: pk,
  ZCONTACTJID: jid,
  ZSESSIONTYPE: kind,
  ZPARTNERNAME: title,
});

const member = (
  pk: number,
  chatPk: number,
  jid: string,
  name: string,
  active: number,
) => ({
  Z_PK: pk,
  ZCHATSESSION: chatPk,
  ZMEMBERJID: jid,
  ZCONTACTNAME: name,
  ZISACTIVE: active,
});

const message = (
  pk: number,
  chatPk: number,
  fromMe: number,
  sentAt: string,
  more: Record<string, SQLInputValue> = {},
) => ({
  Z_PK: pk,
  ZCHATSESSION: chatPk,
  ZISFROMME: fromMe,
  ZSTANZAID: `M${pk}`,
  ZMESSAGETYPE: 0,
  ZMESSAGEDATE: coreData(sentAt),
  ...more,
});

// The call-log entry WhatsApp keeps for a call, and the call.
const entry = (
  pk: number,
  incoming: number,
  missed: number,
  video: number,
) => ({
  Z_PK: pk,
  ZINCOMING: incoming,
  ZMISSED: missed,
  ZVIDEO: video,
});
const call = (
  pk: number,
  entryPk: number,
  startedAt: string,
  duration: number,
  more: Record<string, SQLInputValue> = {},
) => ({
  Z_PK: pk,
  Z1CALLEVENTS: entryPk,
  ZCALLIDSTRING: `CALL-${pk}`,
  ZDATE: coreData(startedAt),
  ZDURATION: duration,
  ...more,
});

// A counterparts row, by its fields: a + identifier is a phone, any other is
// app, and a linked identifier is a phone.
const row = ({
  relation,
  identifier,
  linked = null,
  name = null,
  times = [null, null],
  occurrences = 1,
  context = null,
}: {
  relation: string;
  identifier: string;
  linked?: string | null;
  name?: string | null;
  times?: readonly [string | null, string | null];
  occurrences?: number;
  context?: string | null;
}) => ({
  relation,
  identifier_type: identifier.startsWith('+') ? 'phone' : 'app',
  identifier,
  linked_type: linked === null ? null : 'phone',
  linked_identifier: linked,
  name,
  first_at: times[0],
  last_at: times[1],
  occurrences,
  context,
});

test('WhatsApp counterparts put every person in E.164 or as their LID linked to its number, and an import narrowed to chats still publishes them without what it leaves out', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'whatsapp-counterparts-'),
  );
  whatsappUnder(home.path, {
    'ChatStorage.sqlite': {
      ZWACHATSESSION: [
        chat(1, alice, 0, 'Alice'),
        chat(2, bob, 0, bobsNumber),
        chat(3, group, 1, 'Trip'),
        chat(4, '120363000000000002@newsletter', 5, 'News'),
        // A contact's statuses, which WhatsApp keeps as a chat of their own.
        chat(5, '15550003003@status', 3, 'Dave'),
        chat(6, `${bob}.status`, 3, bobsNumber),
        // The status audience: whom this account's statuses go to.
        chat(7, 'status@broadcast', 2, null),
        chat(8, '0@s.whatsapp.net', 0, 'WhatsApp'),
      ],
      ZWAGROUPMEMBER: [
        member(1, 3, bob, 'Bob', 1),
        member(2, 3, carol, '', 0),
        member(3, 3, alice, 'Alice', 1),
        member(4, 7, alice, '', 1),
      ],
      ZWAMESSAGE: [
        message(1, 1, 0, '2026-10-01T09:00:00Z', { ZFROMJID: alice }),
        message(2, 1, 1, '2026-10-01T10:00:00Z', { ZTOJID: alice }),
        message(3, 1, 0, '2026-10-02T09:00:00Z', { ZFROMJID: alice }),
        message(4, 2, 1, '2026-10-03T09:00:00Z', { ZMESSAGEINFO: 1 }),
        message(5, 2, 0, '2026-10-03T10:00:00Z', { ZMESSAGEINFO: 2 }),
        message(6, 3, 0, '2026-10-04T09:00:00Z', {
          ZFROMJID: group,
          ZGROUPMEMBER: 1,
          ZMESSAGEINFO: 3,
        }),
        message(7, 4, 0, '2026-10-05T09:00:00Z'),
        message(8, 5, 0, '2026-10-06T09:00:00Z'),
        message(9, 6, 0, '2026-10-08T09:00:00Z'),
        message(10, 8, 0, '2026-10-07T09:00:00Z'),
      ],
      ZWAMESSAGEINFO: [
        // Bob's device and this account's own acknowledge what it sent him.
        {
          Z_PK: 1,
          ZMESSAGE: 4,
          ZRECEIPTINFO: receipts('2026-10-03T09:00:00Z', [
            [packedJid(0x8c, '9002'), 2],
            [packedJid(0x8c, '9000'), 4],
          ]),
        },
        // Only this account's devices, by its number and its LID,
        // acknowledge what Bob sent it.
        {
          Z_PK: 2,
          ZMESSAGE: 5,
          ZRECEIPTINFO: receipts('2026-10-03T10:00:00Z', [
            [packedJid(0x81, '15550009000'), 5],
            [packedJid(0x8c, '9000'), 7],
          ]),
        },
        // In a group, other members acknowledge a message too.
        {
          Z_PK: 3,
          ZMESSAGE: 6,
          ZRECEIPTINFO: receipts('2026-10-04T09:00:00Z', [
            [packedJid(0x8c, '9003'), 3],
          ]),
        },
      ],
      ZWAPROFILEPUSHNAME: [
        { Z_PK: 1, ZJID: bob, ZPUSHNAME: 'Bobby' },
        { Z_PK: 2, ZJID: carol, ZPUSHNAME: 'Caz' },
      ],
    },
    'ContactsV2.sqlite': {
      ZWAADDRESSBOOKCONTACT: [
        {
          ZUNIQUEID: 'C-ALICE',
          ZWHATSAPPID: alice,
          ZLID: '9001@lid',
          ZFULLNAME: 'Alice Smith',
        },
        {
          ZUNIQUEID: 'C-CAROL',
          ZWHATSAPPID: '15550004004@s.whatsapp.net',
          ZLID: carol,
          ZFULLNAME: 'Carol Jones',
        },
      ],
    },
    'LID.sqlite': {
      // Carol does not share her number.
      ZWAZACCOUNT: [
        { ZIDENTIFIER: bob, ZPHONENUMBER: '15550002002' },
        { ZIDENTIFIER: '9000@lid', ZPHONENUMBER: '15550009000' },
        { ZIDENTIFIER: carol, ZPHONENUMBER: null },
      ],
    },
    'CallHistory.sqlite': {
      // A video call this account made to Alice, a group call it missed,
      // and a call from Bob it answered.
      ZWAAGGREGATECALLEVENT: [
        entry(1, 0, 0, 1),
        entry(2, 1, 1, 0),
        entry(3, 1, 0, 0),
      ],
      ZWACDCALLEVENT: [
        call(10, 1, '2026-09-10T18:00:00Z', 125.5),
        call(11, 2, '2026-09-11T18:00:00Z', 0, { ZGROUPJIDSTRING: group }),
        call(12, 3, '2026-09-12T18:00:00Z', 60),
      ],
      ZWACDCALLEVENTPARTICIPANT: [
        { Z1PARTICIPANTS: 1, ZJIDSTRING: alice },
        { Z1PARTICIPANTS: 2, ZJIDSTRING: bob },
        { Z1PARTICIPANTS: 2, ZJIDSTRING: carol },
        { Z1PARTICIPANTS: 3, ZJIDSTRING: bob },
      ],
    },
  });
  const connector = await connectorUnder(home.path);

  const everything = await importScope(connector, join(home.path, 'all'), {});
  const narrowed = await importScope(connector, join(home.path, 'narrowed'), {
    collectionIds: [bob, group],
  });

  const counterparts =
    'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM counterparts ORDER BY identifier, relation';
  assert.deepEqual(read(everything, counterparts), [
    // The chat's title names Alice before the address book does; she wrote
    // nothing in the group or to the status audience.
    row({
      relation: 'member',
      identifier: '+15550001001',
      name: 'Alice',
      occurrences: 2,
      context: '{"groups":1,"broadcasts":1,"left":0}',
    }),
    row({
      relation: 'outgoing-call',
      identifier: '+15550001001',
      name: 'Alice',
      times: ['2026-09-10T18:00:00.000000Z', '2026-09-10T18:00:00.000000Z'],
      context: '{"seconds":126,"video":1,"group":0}',
    }),
    row({
      relation: 'received',
      identifier: '+15550001001',
      name: 'Alice',
      times: ['2026-10-01T09:00:00.000000Z', '2026-10-02T09:00:00.000000Z'],
      occurrences: 2,
    }),
    row({
      relation: 'sent',
      identifier: '+15550001001',
      name: 'Alice',
      times: ['2026-10-01T10:00:00.000000Z', '2026-10-01T10:00:00.000000Z'],
    }),
    row({
      relation: 'received',
      identifier: '+15550003003',
      name: 'Dave',
      times: ['2026-10-06T09:00:00.000000Z', '2026-10-06T09:00:00.000000Z'],
      context: '{"statuses":1}',
    }),
    row({
      relation: 'self',
      identifier: '+15550009000',
      times: ['2026-10-03T10:00:05Z', '2026-10-03T10:00:05Z'],
    }),
    // WhatsApp's own account has no E.164 number.
    row({
      relation: 'received',
      identifier: '0@s.whatsapp.net',
      name: 'WhatsApp',
      times: ['2026-10-07T09:00:00.000000Z', '2026-10-07T09:00:00.000000Z'],
    }),
    row({
      relation: 'self',
      identifier: '9000@lid',
      linked: '+15550009000',
      times: ['2026-10-03T10:00:07Z', '2026-10-03T10:00:07Z'],
    }),
    // Bob's chats are titled with his number, so the name he gave stands.
    row({
      relation: 'answered-call',
      identifier: bob,
      linked: '+15550002002',
      name: 'Bobby',
      times: ['2026-09-12T18:00:00.000000Z', '2026-09-12T18:00:00.000000Z'],
      context: '{"seconds":60,"video":0,"group":0}',
    }),
    row({
      relation: 'member',
      identifier: bob,
      linked: '+15550002002',
      name: 'Bobby',
      times: ['2026-10-04T09:00:00.000000Z', '2026-10-04T09:00:00.000000Z'],
      context: '{"groups":1,"broadcasts":0,"left":0}',
    }),
    row({
      relation: 'missed-call',
      identifier: bob,
      linked: '+15550002002',
      name: 'Bobby',
      times: ['2026-09-11T18:00:00.000000Z', '2026-09-11T18:00:00.000000Z'],
      context: '{"seconds":0,"video":0,"group":1}',
    }),
    row({
      relation: 'received',
      identifier: bob,
      linked: '+15550002002',
      name: 'Bobby',
      times: ['2026-10-03T10:00:00.000000Z', '2026-10-08T09:00:00.000000Z'],
      occurrences: 2,
      context: '{"statuses":1}',
    }),
    row({
      relation: 'sent',
      identifier: bob,
      linked: '+15550002002',
      name: 'Bobby',
      times: ['2026-10-03T09:00:00.000000Z', '2026-10-03T09:00:00.000000Z'],
    }),
    // Carol left the group without writing there, and hides her number.
    row({
      relation: 'member',
      identifier: carol,
      name: 'Carol Jones',
      context: '{"groups":1,"broadcasts":0,"left":1}',
    }),
    row({
      relation: 'missed-call',
      identifier: carol,
      name: 'Carol Jones',
      times: ['2026-09-11T18:00:00.000000Z', '2026-09-11T18:00:00.000000Z'],
      context: '{"seconds":0,"video":0,"group":1}',
    }),
  ]);
  // Without users, calls, contacts or push names, LIDs link to nothing and
  // names come from the chats and groups the import holds.
  assert.deepEqual(read(narrowed, counterparts), [
    row({
      relation: 'member',
      identifier: '+15550001001',
      name: 'Alice',
      context: '{"groups":1,"broadcasts":0,"left":0}',
    }),
    row({
      relation: 'self',
      identifier: '+15550009000',
      times: ['2026-10-03T10:00:05Z', '2026-10-03T10:00:05Z'],
    }),
    row({
      relation: 'self',
      identifier: '9000@lid',
      times: ['2026-10-03T10:00:07Z', '2026-10-03T10:00:07Z'],
    }),
    row({
      relation: 'member',
      identifier: bob,
      name: 'Bob',
      times: ['2026-10-04T09:00:00.000000Z', '2026-10-04T09:00:00.000000Z'],
      context: '{"groups":1,"broadcasts":0,"left":0}',
    }),
    row({
      relation: 'received',
      identifier: bob,
      name: 'Bob',
      times: ['2026-10-03T10:00:00.000000Z', '2026-10-03T10:00:00.000000Z'],
    }),
    row({
      relation: 'sent',
      identifier: bob,
      name: 'Bob',
      times: ['2026-10-03T09:00:00.000000Z', '2026-10-03T09:00:00.000000Z'],
    }),
    row({
      relation: 'member',
      identifier: carol,
      context: '{"groups":1,"broadcasts":0,"left":1}',
    }),
  ]);
  // Readers find the view and every column described in the catalog.
  assert.equal(
    read(
      everything,
      "SELECT count(*) AS n FROM catalog WHERE name LIKE 'counterparts.%' AND description <> ''",
    )[0]?.n,
    10,
  );
});
