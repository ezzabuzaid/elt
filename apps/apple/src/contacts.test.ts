import assert from 'node:assert/strict';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Copy, Pipeline } from 'elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import {
  AppleContactsSource,
  ContactsSchemaError,
  ContactsUnavailableError,
} from './index.ts';

const execFile = promisify(execFileCallback);

// AddressBook-v22.abcddb's tables as macOS 26.6.2 creates them (schema only,
// no data), in WAL mode like the real stores.
const addressBookSchema = `PRAGMA journal_mode = WAL;
CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCREATIONDATEYEAR INTEGER, ZDISPLAYFLAGS INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZMODIFICATIONDATEYEAR INTEGER, ZSYNCSTATUS INTEGER, ZCONTAINER INTEGER, ZEXTERNALGROUPBEHAVIOR INTEGER, ZBIRTHDAYYEAR INTEGER, ZPREFERREDFORLINKNAME INTEGER, ZPREFERREDFORLINKPHOTO INTEGER, ZPRIVACYFLAGS INTEGER, ZCONTACTINDEX INTEGER, ZCONTAINER1 INTEGER, ZCONTAINERWHERECONTACTISME INTEGER, ZLUNARBIRTHDAYCOMPONENTS INTEGER, ZNOTE INTEGER, ZASSISTANTSYNCANCHOR INTEGER, ZSHARECOUNT INTEGER, ZSYNCCOUNT INTEGER, ZVERSION INTEGER, ZCONTAINER2 INTEGER, ZGUARDIANFLAGS INTEGER, ZISALL INTEGER, ZTYPE INTEGER, ZINFO INTEGER, ZME INTEGER, Z22_ME INTEGER, ZPROVIDERMETADATA INTEGER, ZCREATIONDATE TIMESTAMP, ZCREATIONDATEYEARLESS FLOAT, ZMODIFICATIONDATE TIMESTAMP, ZMODIFICATIONDATEYEARLESS FLOAT, ZBIRTHDAY TIMESTAMP, ZBIRTHDAYYEARLESS FLOAT, ZIMAGESYNCFAILEDTIME TIMESTAMP, ZWALLPAPERSYNCFAILEDTIME TIMESTAMP, ZLASTSYNCDATE TIMESTAMP, ZEXTERNALCOLLECTIONPATH VARCHAR, ZEXTERNALFILENAME VARCHAR, ZEXTERNALHASH VARCHAR, ZEXTERNALIMAGEURI VARCHAR, ZEXTERNALMODIFICATIONTAG VARCHAR, ZEXTERNALURI VARCHAR, ZEXTERNALUUID VARCHAR, ZUNIQUEID VARCHAR, ZNAME VARCHAR, ZNAMENORMALIZED VARCHAR, ZTMPREMOTELOCATION VARCHAR, ZCROPRECT VARCHAR, ZCROPRECTID VARCHAR, ZDEPARTMENT VARCHAR, ZDOWNTIMEWHITELIST VARCHAR, ZFIRSTNAME VARCHAR, ZIDENTITYUNIQUEID VARCHAR, ZIMAGEREFERENCE VARCHAR, ZIMAGETYPE VARCHAR, ZJOBTITLE VARCHAR, ZLASTNAME VARCHAR, ZLINKID VARCHAR, ZMAIDENNAME VARCHAR, ZMIDDLENAME VARCHAR, ZNICKNAME VARCHAR, ZORGANIZATION VARCHAR, ZPHONEMEDATA VARCHAR, ZPHONETICFIRSTNAME VARCHAR, ZPHONETICLASTNAME VARCHAR, ZPHONETICMIDDLENAME VARCHAR, ZPHONETICORGANIZATION VARCHAR, ZPREFERREDAPPLEPERSONAIDENTIFIER VARCHAR, ZPREFERREDLIKENESSSOURCE VARCHAR, ZSORTINGFIRSTNAME VARCHAR, ZSORTINGLASTNAME VARCHAR, ZSUFFIX VARCHAR, ZTITLE VARCHAR, ZTMPHOMEPAGE VARCHAR, ZWALLPAPERURI VARCHAR, ZASSISTANTVALIDITY VARCHAR, ZCREATEDVERSION VARCHAR, ZLASTDOTMACACCOUNT VARCHAR, ZLASTSAVEDVERSION VARCHAR, ZSYNCANCHOR VARCHAR, ZEXTERNALIDENTIFIER VARCHAR, ZNAME1 VARCHAR, ZPROVIDERIDENTIFIER VARCHAR, ZREMOTELOCATION VARCHAR, ZSERIALNUMBER VARCHAR, ZEXTERNALREPRESENTATION BLOB, ZMODIFIEDUNIQUEIDSDATA BLOB, ZSEARCHELEMENTDATA BLOB, ZAVATARRECIPEDATA BLOB, ZCROPRECTHASH BLOB, ZIMAGEDATA BLOB, ZIMAGEHASH BLOB, ZMEMOJIMETADATA BLOB, ZSENSITIVECONTENTCONFIGURATION BLOB, ZTHUMBNAILIMAGEDATA BLOB, ZWALLPAPER BLOB );
CREATE TABLE Z_22PARENTGROUPS (Z_22CONTACTS INTEGER, Z_19PARENTGROUPS1 INTEGER, PRIMARY KEY (Z_22CONTACTS, Z_19PARENTGROUPS1) );
CREATE TABLE Z_18PARENTGROUPS (Z_18CHILDGROUPS INTEGER, Z_19PARENTGROUPS INTEGER, PRIMARY KEY (Z_18CHILDGROUPS, Z_19PARENTGROUPS) );
CREATE TABLE ZABCDNOTE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACT INTEGER, Z22_CONTACT INTEGER, ZTEXT VARCHAR, ZRICHTEXTDATA BLOB );
CREATE TABLE ZABCDDATECOMPONENTS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDAY INTEGER, ZERA INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISLEAPMONTH INTEGER, ZMONTH INTEGER, ZYEAR INTEGER, ZCONTACT INTEGER, Z22_CONTACT INTEGER, ZCALENDARIDENTIFIER VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZAREACODE VARCHAR, ZCOUNTRYCODE VARCHAR, ZEXTENSION VARCHAR, ZFULLNUMBER VARCHAR, ZLABEL VARCHAR, ZLASTFOURDIGITS VARCHAR, ZLOCALNUMBER VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZADDRESS VARCHAR, ZADDRESSNORMALIZED VARCHAR, ZLABEL VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDPOSTALADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZCITY VARCHAR, ZCOUNTRYCODE VARCHAR, ZCOUNTRYNAME VARCHAR, ZLABEL VARCHAR, ZREGION VARCHAR, ZSAMA VARCHAR, ZSTATE VARCHAR, ZSTREET VARCHAR, ZSUBLOCALITY VARCHAR, ZUNIQUEID VARCHAR, ZZIPCODE VARCHAR, ZCUSTOMVALUESDICTIONARY BLOB );
CREATE TABLE ZABCDURLADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZLABEL VARCHAR, ZUNIQUEID VARCHAR, ZURL VARCHAR );
CREATE TABLE ZABCDSOCIALPROFILE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZBUNDLEIDENTIFIERSSTRING VARCHAR, ZDISPLAYNAME VARCHAR, ZLABEL VARCHAR, ZSERVICENAME VARCHAR, ZTEAMIDENTIFIER VARCHAR, ZUNIQUEID VARCHAR, ZURLSTRING VARCHAR, ZUSERIDENTIFIER VARCHAR, ZUSERNAME VARCHAR, ZCUSTOMVALUESDATA BLOB );
CREATE TABLE ZABCDMESSAGINGADDRESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZSERVICE INTEGER, ZADDRESS VARCHAR, ZBUNDLEIDENTIFIERSSTRING VARCHAR, ZLABEL VARCHAR, ZTEAMIDENTIFIER VARCHAR, ZUNIQUEID VARCHAR, ZUSERIDENTIFIER VARCHAR );
CREATE TABLE ZABCDSERVICE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSERVICENAME VARCHAR );
CREATE TABLE ZABCDRELATEDNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZLABEL VARCHAR, ZNAME VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDCONTACTDATE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDATEYEAR INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZDATE TIMESTAMP, ZDATEYEARLESS FLOAT, ZLABEL VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDCALENDARURI (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZLABEL VARCHAR, ZUNIQUEID VARCHAR, ZURL VARCHAR );
CREATE TABLE ZABCDADDRESSINGGRAMMAR (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZADDRESSINGGRAMMAR VARCHAR, ZLABEL VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDLIKENESS (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZKIND INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZLABEL VARCHAR, ZUNIQUEID VARCHAR, ZVERSION VARCHAR, ZDATA BLOB );
CREATE TABLE ZABCDALERTTONE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZOWNER INTEGER, Z22_OWNER INTEGER, ZTONEDATA VARCHAR, ZTYPE VARCHAR, ZUNIQUEID VARCHAR );
CREATE TABLE ZABCDCUSTOMPROPERTY (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZVALUETYPE INTEGER, ZPROPERTYNAME VARCHAR, ZRECORDTYPE VARCHAR );
CREATE TABLE ZABCDCUSTOMPROPERTYVALUE (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZDATEVALUEYEAR INTEGER, ZIOSLEGACYIDENTIFIER INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZCUSTOMPROPERTY INTEGER, ZOWNER INTEGER, Z17_OWNER INTEGER, ZDATEVALUE TIMESTAMP, ZDATEVALUEYEARLESS FLOAT, ZNUMBERVALUE FLOAT, ZLABEL VARCHAR, ZSTRINGVALUE VARCHAR, ZUNIQUEID VARCHAR, ZDATAVALUE BLOB );
CREATE TABLE ZABCDREMOTELOCATION (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZISPRIMARY INTEGER, ZISPRIVATE INTEGER, ZORDERINGINDEX INTEGER, ZOWNER INTEGER, Z17_OWNER INTEGER, ZLABEL VARCHAR, ZUNIQUEID VARCHAR, ZURL VARCHAR );
CREATE TABLE ZABCDUNKNOWNPROPERTY (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, Z17_OWNER INTEGER, ZPROPERTYNAME VARCHAR, ZORIGINALLINE BLOB );
CREATE TABLE ZABCDDISTRIBUTIONLISTCONFIG (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZADDRESS INTEGER, ZCONTACT INTEGER, Z22_CONTACT INTEGER, ZEMAIL INTEGER, ZGROUP INTEGER, Z19_GROUP INTEGER, ZPHONE INTEGER, ZPROPERTYNAME VARCHAR );`;

// Z_PRIMARYKEY's entities as the ABAddressBook-24A2 model numbers them.
const entities: readonly (readonly [number, string, number])[] = [
  [1, 'ABCDAddressingGrammar', 0],
  [2, 'ABCDAlertTone', 0],
  [3, 'ABCDCalendarURI', 0],
  [4, 'ABCDContactDate', 0],
  [5, 'ABCDContactIndex', 0],
  [6, 'ABCDCustomProperty', 0],
  [7, 'ABCDCustomPropertyValue', 0],
  [8, 'ABCDDateComponents', 0],
  [9, 'ABCDDeletedRecordLog', 0],
  [10, 'ABCDDistributionListConfig', 0],
  [11, 'ABCDEmailAddress', 0],
  [12, 'ABCDLikeness', 0],
  [13, 'ABCDMessagingAddress', 0],
  [14, 'ABCDNote', 0],
  [15, 'ABCDPhoneNumber', 0],
  [16, 'ABCDPostalAddress', 0],
  [17, 'ABCDRecord', 0],
  [18, 'ABCDAbstractGroup', 17],
  [19, 'ABCDGroup', 18],
  [20, 'ABCDSubscribedGroup', 19],
  [21, 'ABCDSmartGroup', 18],
  [22, 'ABCDContact', 17],
  [23, 'ABCDSubscribedContact', 22],
  [24, 'ABCDInfo', 17],
  [25, 'CNCDContainer', 17],
  [26, 'ABCDRelatedName', 0],
  [27, 'ABCDRemoteLocation', 0],
  [28, 'ABCDService', 0],
  [29, 'ABCDSocialProfile', 0],
  [30, 'ABCDUnknownProperty', 0],
  [31, 'ABCDURLAddress', 0],
  [32, 'CNCDChangeHistoryClient', 0],
  [33, 'CNCDProviderMetadata', 0],
  [34, 'CNCDUnifiedContactInfo', 0],
];

const appleSeconds = (iso: string) =>
  (Date.parse(iso) - Date.UTC(2001, 0, 1)) / 1000;
// Contacts writes birthdays and dates at noon UTC, in 1604 without a year.
const noon = (date: string) => appleSeconds(`${date}T12:00:00.000Z`);

// A 4x4 PNG; Vision OCR in MacOSDocumentParser fails below 3x3 (#2038).
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAABKADAAQAAAABAAAABAAAAADFbP4CAAAAFklEQVQIHWP8z8BQz4AEmJDYYCZhAQBj0QGGfotxxgAAAABJRU5ErkJggg==',
  'base64',
);
// Core Data's two forms of data that allows external storage.
const inline = (bytes: Uint8Array) => Buffer.concat([Buffer.from([1]), bytes]);
const external = (id: string) =>
  Buffer.concat([Buffer.from([2]), Buffer.from(id, 'ascii'), Buffer.from([0])]);

const binaryPlist = (xml: string) =>
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
    input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml}</plist>`,
  });

type Rows = Record<string, readonly Record<string, SQLInputValue>[]>;

function createStore(
  directory: string,
  rows: Rows,
  files: Record<string, Uint8Array> = {},
): void {
  const externalData = join(
    directory,
    '.AddressBook-v22_SUPPORT/_EXTERNAL_DATA',
  );
  mkdirSync(externalData, { recursive: true });
  for (const [id, bytes] of Object.entries(files))
    writeFileSync(join(externalData, id), bytes);
  using database = new DatabaseSync(join(directory, 'AddressBook-v22.abcddb'));
  database.exec(addressBookSchema);
  const entity = database.prepare(
    'INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME, Z_SUPER, Z_MAX) VALUES (?, ?, ?, 0)',
  );
  for (const [number, name, parent] of entities)
    entity.run(number, name, parent);
  for (const [table, list] of Object.entries(rows))
    for (const row of list) {
      const columns = Object.keys(row);
      database
        .prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        )
        .run(...Object.values(row));
    }
}

const contact = 22;
const group = 19;
const smartGroup = 21;
const info = 24;
const container = 25;

// The On My Mac store and two account stores, as Contacts lays them out.
function addressBookFixture(directory: string): string {
  createStore(
    directory,
    {
      ZABCDRECORD: [
        {
          Z_PK: 1,
          Z_ENT: container,
          ZUNIQUEID: 'LOCAL:ABContainer',
          ZISALL: 1,
          ZTYPE: 0,
          ZREMOTELOCATION: 'local',
          ZME: 2,
          ZCREATIONDATE: appleSeconds('2025-01-02T03:04:05.006Z'),
        },
        {
          Z_PK: 2,
          Z_ENT: contact,
          ZUNIQUEID: 'ME:ABPerson',
          ZCONTAINER1: 1,
          ZCONTAINERWHERECONTACTISME: 1,
          ZFIRSTNAME: 'Ada',
          ZLASTNAME: 'Local',
          ZBIRTHDAY: noon('1604-07-09'),
          ZBIRTHDAYYEAR: 1604,
          ZIMAGEDATA: external('EXTERNAL-ME'),
          ZPREFERREDFORLINKNAME: 1,
          ZPREFERREDFORLINKPHOTO: 0,
          ZMODIFICATIONDATE: appleSeconds('2025-01-03T00:00:00.000Z'),
        },
        { Z_PK: 3, Z_ENT: info, ZUNIQUEID: 'INFO:ABInfo', ZSYNCANCHOR: 'a' },
      ],
      ZABCDNOTE: [{ Z_PK: 1, ZCONTACT: 2, ZTEXT: 'first line\nsecond ✓' }],
    },
    { 'EXTERNAL-ME': png },
  );
  const sources = join(directory, 'Sources');
  createStore(join(sources, 'ACCOUNT-A'), {
    ZABCDRECORD: [
      { Z_PK: 1, Z_ENT: container, ZUNIQUEID: 'A:ABContainer', ZTYPE: 0 },
      {
        Z_PK: 2,
        Z_ENT: group,
        ZUNIQUEID: 'FRIENDS:ABGroup',
        ZCONTAINER: 1,
        ZNAME: 'Friends',
        ZNAMENORMALIZED: 'friends',
        ZEXTERNALGROUPBEHAVIOR: 0,
      },
      {
        Z_PK: 3,
        Z_ENT: smartGroup,
        ZUNIQUEID: 'SMART:ABGroup',
        ZCONTAINER: 1,
        ZNAME: 'Recent',
        ZSEARCHELEMENTDATA: binaryPlist(
          '<dict><key>property</key><string>modificationDate</string></dict>',
        ),
      },
      {
        Z_PK: 4,
        Z_ENT: contact,
        ZUNIQUEID: 'GRACE:ABPerson',
        ZCONTAINER1: 1,
        ZFIRSTNAME: 'Grace',
        ZLASTNAME: 'Hopper',
        ZSORTINGFIRSTNAME: 'grace hopper',
        ZORGANIZATION: 'Navy',
        ZBIRTHDAY: noon('1906-12-09'),
        ZBIRTHDAYYEAR: 1906,
        ZTHUMBNAILIMAGEDATA: inline(png),
        ZIMAGEHASH: Buffer.from([1, 2, 3]),
        ZPREFERREDFORLINKNAME: 0,
        ZPREFERREDFORLINKPHOTO: 1,
        ZLUNARBIRTHDAYCOMPONENTS: 1,
      },
      {
        Z_PK: 5,
        Z_ENT: contact,
        ZUNIQUEID: 'ALAN:ABPerson',
        ZCONTAINER1: 1,
        ZFIRSTNAME: 'Alan',
      },
    ],
    Z_22PARENTGROUPS: [
      { Z_22CONTACTS: 4, Z_19PARENTGROUPS1: 2 },
      { Z_22CONTACTS: 5, Z_19PARENTGROUPS1: 2 },
    ],
    Z_18PARENTGROUPS: [{ Z_18CHILDGROUPS: 3, Z_19PARENTGROUPS: 2 }],
    ZABCDPHONENUMBER: [
      {
        Z_PK: 1,
        ZOWNER: 4,
        ZUNIQUEID: 'PHONE-1',
        ZFULLNUMBER: '+1 555 0100',
        ZLASTFOURDIGITS: '0100',
        ZLABEL: '_$!<Mobile>!$_',
        ZISPRIMARY: 1,
        ZORDERINGINDEX: 0,
        ZIOSLEGACYIDENTIFIER: 5,
      },
      {
        Z_PK: 2,
        ZOWNER: 5,
        ZUNIQUEID: 'PHONE-2',
        ZFULLNUMBER: '555-0101',
        ZLABEL: 'Lab',
        ZORDERINGINDEX: 0,
      },
    ],
    ZABCDEMAILADDRESS: [
      {
        Z_PK: 1,
        ZOWNER: 4,
        ZUNIQUEID: 'EMAIL-1',
        ZADDRESS: 'grace@example.com',
        ZLABEL: '_$!<Work>!$_',
      },
    ],
    ZABCDPOSTALADDRESS: [
      {
        Z_PK: 1,
        ZOWNER: 4,
        ZUNIQUEID: 'ADDRESS-1',
        ZSTREET: '1 Main St\nApt 2',
        ZCITY: 'Arlington',
        ZCOUNTRYCODE: 'us',
        ZCUSTOMVALUESDICTIONARY: binaryPlist(
          '<dict><key>floor</key><string>3</string></dict>',
        ),
      },
    ],
    ZABCDURLADDRESS: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'URL-1',
        ZURL: 'https://example.com',
        ZLABEL: '_$!<HomePage>!$_',
      },
    ],
    ZABCDSOCIALPROFILE: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'SOCIAL-1',
        ZSERVICENAME: 'Twitter',
        ZUSERNAME: 'grace',
        ZURLSTRING: 'http://twitter.com/grace',
        ZLABEL: '',
      },
    ],
    ZABCDSERVICE: [{ Z_PK: 1, ZSERVICENAME: 'SkypeInstant' }],
    ZABCDMESSAGINGADDRESS: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'IM-1',
        ZADDRESS: 'grace.h',
        ZSERVICE: 1,
        ZLABEL: '_$!<Home>!$_',
      },
    ],
    ZABCDRELATEDNAME: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'RELATED-1',
        ZNAME: 'Vincent',
        ZLABEL: '_$!<Spouse>!$_',
      },
    ],
    ZABCDCONTACTDATE: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'DATE-1',
        ZDATE: noon('1930-06-15'),
        ZDATEYEAR: 1930,
        ZLABEL: '_$!<Anniversary>!$_',
      },
      {
        ZOWNER: 4,
        ZUNIQUEID: 'DATE-2',
        ZDATE: noon('1604-12-25'),
        ZDATEYEAR: 1604,
        ZLABEL: 'holiday',
      },
    ],
    ZABCDDATECOMPONENTS: [
      {
        Z_PK: 1,
        ZCONTACT: 4,
        ZUNIQUEID: 'LUNAR-1',
        ZCALENDARIDENTIFIER: 'chinese',
        ZERA: 78,
        ZYEAR: 40,
        ZMONTH: 5,
        ZDAY: 20,
        ZISLEAPMONTH: 0,
        ZIOSLEGACYIDENTIFIER: 1,
      },
    ],
    ZABCDCALENDARURI: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'CALENDAR-1',
        ZURL: 'https://calendar.example.com/grace',
      },
    ],
    ZABCDADDRESSINGGRAMMAR: [
      { ZOWNER: 4, ZUNIQUEID: 'GRAMMAR-1', ZADDRESSINGGRAMMAR: 'AAAA' },
    ],
    ZABCDLIKENESS: [
      {
        ZOWNER: 4,
        ZUNIQUEID: 'LIKENESS-1',
        ZKIND: 1,
        ZVERSION: '1',
        ZDATA: Buffer.from('likeness'),
      },
    ],
    ZABCDALERTTONE: [
      { ZOWNER: 4, ZUNIQUEID: 'TONE-1', ZTYPE: 'ringtone', ZTONEDATA: 'Chime' },
    ],
    ZABCDCUSTOMPROPERTY: [
      {
        Z_PK: 1,
        ZPROPERTYNAME: 'X-FAVORITE',
        ZRECORDTYPE: 'ABPerson',
        ZVALUETYPE: 1,
      },
    ],
    ZABCDCUSTOMPROPERTYVALUE: [
      {
        ZOWNER: 4,
        ZCUSTOMPROPERTY: 1,
        ZUNIQUEID: 'CUSTOM-1',
        ZSTRINGVALUE: 'tea',
      },
    ],
    ZABCDREMOTELOCATION: [
      {
        ZOWNER: 1,
        ZUNIQUEID: 'REMOTE-1',
        ZURL: 'https://contacts.example.com/',
      },
    ],
    // Contacts may keep the same unknown vCard line twice; it is one fact.
    ZABCDUNKNOWNPROPERTY: [
      {
        ZOWNER: 4,
        ZPROPERTYNAME: 'X-ODD',
        ZORIGINALLINE: Buffer.from('X-ODD:1'),
      },
      {
        ZOWNER: 4,
        ZPROPERTYNAME: 'X-ODD',
        ZORIGINALLINE: Buffer.from('X-ODD:1'),
      },
      {
        ZOWNER: 4,
        ZPROPERTYNAME: 'X-ODD',
        ZORIGINALLINE: Buffer.from('X-ODD:2'),
      },
    ],
    ZABCDDISTRIBUTIONLISTCONFIG: [
      { ZGROUP: 2, ZCONTACT: 4, ZPROPERTYNAME: 'Email', ZEMAIL: 1 },
    ],
  });
  createStore(
    join(sources, 'ACCOUNT-B'),
    {
      ZABCDRECORD: [
        { Z_PK: 1, Z_ENT: container, ZUNIQUEID: 'B:ABContainer', ZTYPE: 0 },
        {
          Z_PK: 2,
          Z_ENT: contact,
          ZUNIQUEID: 'BOB:ABPerson',
          ZCONTAINER1: 1,
          ZFIRSTNAME: 'Bob',
          ZTHUMBNAILIMAGEDATA: external('EXTERNAL-BOB'),
        },
      ],
    },
    { 'EXTERNAL-BOB': Buffer.from('not really a jpeg') },
  );
  return directory;
}

function rows(path: string, sql: string): Record<string, unknown>[] {
  using database = new DatabaseSync(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

// A file column's bytes, reassembled from the chunks elt-sqlite stores.
function fileBytes(path: string, table: string, file: unknown): Buffer {
  return Buffer.concat(
    rows(
      path,
      `SELECT bytes FROM "_mac_elt_files_${table}_bytes" WHERE file = ${Number(file)} ORDER BY n`,
    ).map(({ bytes }) => bytes as Uint8Array),
  );
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function copies(source: AppleContactsSource, destination: SQLiteDestination) {
  return source.discover().then(({ streams }) =>
    streams.map(
      (stream) =>
        new Copy(
          stream,
          stream.supportsFileTransfer
            ? destination.table(stream.name, (columns) => [
                ...SQLiteColumns.fromSchema(stream.jsonSchema),
                columns.blob('bytes').from(stream.file),
              ])
            : destination.table(stream.name),
          {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            primaryKey: [...stream.primaryKey],
          },
        ),
    ),
  );
}

test('Contacts exports every stream of every account store by identifier', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const source = new AppleContactsSource(
    addressBookFixture(join(scratch.path, 'AddressBook')),
  );
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });

  const results = await new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: await copies(source, destination),
  }).run();

  assert.deepEqual(
    results.map(({ copy, count }) => [copy.from.name, count]),
    [
      ['containers', 3],
      ['groups', 2],
      ['groupMembers', 2],
      ['groupSubgroups', 1],
      ['contacts', 4],
      ['notes', 1],
      ['alternateBirthdays', 1],
      ['phoneNumbers', 2],
      ['emailAddresses', 1],
      ['postalAddresses', 1],
      ['urlAddresses', 1],
      ['socialProfiles', 1],
      ['messagingAddresses', 1],
      ['relatedNames', 1],
      ['contactDates', 2],
      ['calendarUris', 1],
      ['addressingGrammars', 1],
      ['likenesses', 1],
      ['alertTones', 1],
      ['customPropertyValues', 1],
      ['remoteLocations', 1],
      ['unknownProperties', 2],
      ['distributionListConfigs', 1],
      ['images', 3],
    ],
  );
  const out = destination.path;
  assert.deepEqual(
    rows(
      out,
      'SELECT id, source, isAll, remoteLocation, meContactId, creationDate FROM containers ORDER BY id',
    ),
    [
      {
        id: 'A:ABContainer',
        source: 'ACCOUNT-A',
        isAll: null,
        remoteLocation: null,
        meContactId: null,
        creationDate: null,
      },
      {
        id: 'B:ABContainer',
        source: 'ACCOUNT-B',
        isAll: null,
        remoteLocation: null,
        meContactId: null,
        creationDate: null,
      },
      {
        id: 'LOCAL:ABContainer',
        source: null,
        isAll: 1,
        remoteLocation: 'local',
        meContactId: 'ME:ABPerson',
        creationDate: '2025-01-02T03:04:05.006Z',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, kind, containerId, firstName, lastName, organization, birthdayYear, birthdayMonth, birthdayDay, meOfContainerId, imageHash, preferredForLinkName, modificationDate FROM contacts ORDER BY id',
    ),
    [
      {
        id: 'ALAN:ABPerson',
        kind: 'contact',
        containerId: 'A:ABContainer',
        firstName: 'Alan',
        lastName: null,
        organization: null,
        birthdayYear: null,
        birthdayMonth: null,
        birthdayDay: null,
        meOfContainerId: null,
        imageHash: null,
        preferredForLinkName: null,
        modificationDate: null,
      },
      {
        id: 'BOB:ABPerson',
        kind: 'contact',
        containerId: 'B:ABContainer',
        firstName: 'Bob',
        lastName: null,
        organization: null,
        birthdayYear: null,
        birthdayMonth: null,
        birthdayDay: null,
        meOfContainerId: null,
        imageHash: null,
        preferredForLinkName: null,
        modificationDate: null,
      },
      {
        id: 'GRACE:ABPerson',
        kind: 'contact',
        containerId: 'A:ABContainer',
        firstName: 'Grace',
        lastName: 'Hopper',
        organization: 'Navy',
        birthdayYear: 1906,
        birthdayMonth: 12,
        birthdayDay: 9,
        meOfContainerId: null,
        imageHash: 'AQID',
        preferredForLinkName: 0,
        modificationDate: null,
      },
      {
        id: 'ME:ABPerson',
        kind: 'contact',
        containerId: 'LOCAL:ABContainer',
        firstName: 'Ada',
        lastName: 'Local',
        birthdayYear: null,
        birthdayMonth: 7,
        birthdayDay: 9,
        organization: null,
        meOfContainerId: 'LOCAL:ABContainer',
        imageHash: null,
        preferredForLinkName: 1,
        modificationDate: '2025-01-03T00:00:00.000Z',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, kind, name, containerId, searchElementData FROM groups ORDER BY id',
    ),
    [
      {
        id: 'FRIENDS:ABGroup',
        kind: 'group',
        name: 'Friends',
        containerId: 'A:ABContainer',
        searchElementData: null,
      },
      {
        id: 'SMART:ABGroup',
        kind: 'smartGroup',
        name: 'Recent',
        containerId: 'A:ABContainer',
        searchElementData: '{"property":"modificationDate"}',
      },
    ],
  );
  assert.deepEqual(
    rows(out, 'SELECT groupId, contactId FROM groupMembers ORDER BY contactId'),
    [
      { groupId: 'FRIENDS:ABGroup', contactId: 'ALAN:ABPerson' },
      { groupId: 'FRIENDS:ABGroup', contactId: 'GRACE:ABPerson' },
    ],
  );
  assert.deepEqual(
    rows(out, 'SELECT parentGroupId, childGroupId FROM groupSubgroups'),
    [{ parentGroupId: 'FRIENDS:ABGroup', childGroupId: 'SMART:ABGroup' }],
  );
  assert.deepEqual(
    rows(out, 'SELECT contactId, text, richTextData FROM notes'),
    [
      {
        contactId: 'ME:ABPerson',
        text: 'first line\nsecond ✓',
        richTextData: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT contactId, calendarIdentifier, era, year, month, day, isLeapMonth FROM alternateBirthdays',
    ),
    [
      {
        contactId: 'GRACE:ABPerson',
        calendarIdentifier: 'chinese',
        era: 78,
        year: 40,
        month: 5,
        day: 20,
        isLeapMonth: 0,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, contactId, label, fullNumber, isPrimary, orderingIndex, iOSLegacyIdentifier FROM phoneNumbers ORDER BY id',
    ),
    [
      {
        id: 'PHONE-1',
        contactId: 'GRACE:ABPerson',
        label: '_$!<Mobile>!$_',
        fullNumber: '+1 555 0100',
        isPrimary: 1,
        orderingIndex: 0,
        iOSLegacyIdentifier: 5,
      },
      {
        id: 'PHONE-2',
        contactId: 'ALAN:ABPerson',
        label: 'Lab',
        fullNumber: '555-0101',
        isPrimary: null,
        orderingIndex: 0,
        iOSLegacyIdentifier: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT street, city, customValuesDictionary FROM postalAddresses',
    ),
    [
      {
        street: '1 Main St\nApt 2',
        city: 'Arlington',
        customValuesDictionary: '{"floor":"3"}',
      },
    ],
  );
  assert.deepEqual(
    rows(out, 'SELECT address, service, label FROM messagingAddresses'),
    [{ address: 'grace.h', service: 'SkypeInstant', label: '_$!<Home>!$_' }],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, label, year, month, day FROM contactDates ORDER BY id',
    ),
    [
      {
        id: 'DATE-1',
        label: '_$!<Anniversary>!$_',
        year: 1930,
        month: 6,
        day: 15,
      },
      { id: 'DATE-2', label: 'holiday', year: null, month: 12, day: 25 },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, recordId, propertyName, recordType, valueType, stringValue FROM customPropertyValues',
    ),
    [
      {
        id: 'CUSTOM-1',
        recordId: 'GRACE:ABPerson',
        propertyName: 'X-FAVORITE',
        recordType: 'ABPerson',
        valueType: 1,
        stringValue: 'tea',
      },
    ],
  );
  assert.deepEqual(rows(out, 'SELECT recordId, url FROM remoteLocations'), [
    { recordId: 'A:ABContainer', url: 'https://contacts.example.com/' },
  ]);
  assert.deepEqual(
    rows(
      out,
      'SELECT propertyName, originalLine FROM unknownProperties ORDER BY originalLine',
    ),
    [
      {
        propertyName: 'X-ODD',
        originalLine: Buffer.from('X-ODD:1').toString('base64'),
      },
      {
        propertyName: 'X-ODD',
        originalLine: Buffer.from('X-ODD:2').toString('base64'),
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT groupId, contactId, propertyName, emailId, phoneId, addressId FROM distributionListConfigs',
    ),
    [
      {
        groupId: 'FRIENDS:ABGroup',
        contactId: 'GRACE:ABPerson',
        propertyName: 'Email',
        emailId: 'EMAIL-1',
        phoneId: null,
        addressId: null,
      },
    ],
  );
  const images = rows(
    out,
    'SELECT contactId, kind, storage, externalId, byteLength, sha256, bytes FROM images ORDER BY contactId',
  );
  const jpeg = Buffer.from('not really a jpeg');
  assert.deepEqual(
    images.map(({ bytes, ...image }) => ({
      ...image,
      bytes: fileBytes(out, 'images', bytes),
    })),
    [
      {
        contactId: 'BOB:ABPerson',
        kind: 'thumbnail',
        storage: 'external',
        externalId: 'EXTERNAL-BOB',
        byteLength: jpeg.length,
        sha256: sha256(jpeg),
        bytes: jpeg,
      },
      {
        contactId: 'GRACE:ABPerson',
        kind: 'thumbnail',
        storage: 'inline',
        externalId: null,
        byteLength: png.length,
        sha256: sha256(png),
        bytes: png,
      },
      {
        contactId: 'ME:ABPerson',
        kind: 'image',
        storage: 'external',
        externalId: 'EXTERNAL-ME',
        byteLength: png.length,
        sha256: sha256(png),
        bytes: png,
      },
    ],
  );
});

test('Contacts loads edits incrementally, deletes removed rows and writes nothing when unchanged', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  const source = new AppleContactsSource(directory);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const all = await copies(source, destination);
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: all.filter(({ from }) =>
      ['contacts', 'phoneNumbers', 'groupMembers', 'images'].includes(
        from.name,
      ),
    ),
  });
  const counts = (results: Awaited<ReturnType<typeof pipeline.run>>) =>
    Object.fromEntries(
      results.map(({ copy, count, deleted }) => [
        copy.from.name,
        { count, deleted },
      ]),
    );

  await pipeline.run();
  const unchanged = await pipeline.run();
  {
    using store = new DatabaseSync(
      join(directory, 'Sources/ACCOUNT-A/AddressBook-v22.abcddb'),
    );
    store.exec(`
      UPDATE ZABCDRECORD SET ZJOBTITLE = 'Rear Admiral' WHERE ZUNIQUEID = 'GRACE:ABPerson';
      UPDATE ZABCDPHONENUMBER SET ZFULLNUMBER = '555-0102' WHERE ZUNIQUEID = 'PHONE-2';
      DELETE FROM Z_22PARENTGROUPS WHERE Z_22CONTACTS = 5;
      DELETE FROM ZABCDPHONENUMBER WHERE ZOWNER = 5;
      DELETE FROM ZABCDRECORD WHERE ZUNIQUEID = 'ALAN:ABPerson';
    `);
    store
      .prepare(
        "UPDATE ZABCDRECORD SET ZTHUMBNAILIMAGEDATA = ? WHERE ZUNIQUEID = 'GRACE:ABPerson'",
      )
      .run(inline(Buffer.from('a new photo')));
  }
  const changed = await pipeline.run();

  assert.deepEqual(counts(unchanged), {
    contacts: { count: 0, deleted: 0 },
    phoneNumbers: { count: 0, deleted: 0 },
    groupMembers: { count: 0, deleted: 0 },
    images: { count: 0, deleted: 0 },
  });
  assert.deepEqual(counts(changed), {
    contacts: { count: 1, deleted: 1 },
    phoneNumbers: { count: 0, deleted: 1 },
    groupMembers: { count: 0, deleted: 1 },
    images: { count: 1, deleted: 0 },
  });
  assert.deepEqual(
    rows(destination.path, 'SELECT id, jobTitle FROM contacts ORDER BY id'),
    [
      { id: 'BOB:ABPerson', jobTitle: null },
      { id: 'GRACE:ABPerson', jobTitle: 'Rear Admiral' },
      { id: 'ME:ABPerson', jobTitle: null },
    ],
  );
  const [grace] = rows(
    destination.path,
    "SELECT byteLength, bytes FROM images WHERE contactId = 'GRACE:ABPerson'",
  );
  assert.deepEqual(
    fileBytes(destination.path, 'images', grace?.bytes),
    Buffer.from('a new photo'),
  );
});

test('Contacts refuses a store it cannot read instead of reading its account as empty', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  const source = new AppleContactsSource(directory);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: (await copies(source, destination)).filter(
      ({ from }) => from.name === 'contacts',
    ),
  });
  await pipeline.run();
  rmSync(join(directory, 'Sources/ACCOUNT-B/AddressBook-v22.abcddb'));

  await assert.rejects(pipeline.run(), (error: Error) => {
    assert.ok(error instanceof ContactsUnavailableError);
    assert.match(
      error.message,
      /ACCOUNT-B.*Contacts access or Full Disk Access/,
    );
    return true;
  });
  assert.equal(
    rows(destination.path, 'SELECT count(*) AS n FROM contacts')[0]?.n,
    4,
  );
  await assert.rejects(
    new AppleContactsSource(join(scratch.path, 'missing')).session(),
    ContactsUnavailableError,
  );
});

test('Contacts names the columns it needs when a store has another layout', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  {
    using store = new DatabaseSync(
      join(directory, 'Sources/ACCOUNT-A/AddressBook-v22.abcddb'),
    );
    store.exec('ALTER TABLE ZABCDPHONENUMBER DROP COLUMN ZFULLNUMBER');
  }

  await assert.rejects(
    new AppleContactsSource(directory).session(),
    (error: Error) => {
      assert.ok(error instanceof ContactsSchemaError);
      assert.match(error.message, /ACCOUNT-A.*ZABCDPHONENUMBER\.ZFULLNUMBER/);
      return true;
    },
  );
});

test('Contacts refuses a store whose entities it does not know instead of reading no contacts', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  {
    using store = new DatabaseSync(
      join(directory, 'Sources/ACCOUNT-B/AddressBook-v22.abcddb'),
    );
    store.exec(
      "UPDATE Z_PRIMARYKEY SET Z_NAME = 'ABCDPerson' WHERE Z_NAME = 'ABCDContact'",
    );
  }

  await assert.rejects(
    new AppleContactsSource(directory).session(),
    (error: Error) => {
      assert.ok(error instanceof ContactsSchemaError);
      assert.match(error.message, /ACCOUNT-B.*entity ABCDContact/);
      return true;
    },
  );
});

test('Contacts rejects image data in an encoding it does not know', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  {
    using store = new DatabaseSync(
      join(directory, 'Sources/ACCOUNT-B/AddressBook-v22.abcddb'),
    );
    store
      .prepare('UPDATE ZABCDRECORD SET ZTHUMBNAILIMAGEDATA = ? WHERE Z_PK = 2')
      .run(Buffer.from([3, 0]));
  }
  const source = new AppleContactsSource(directory);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: (await copies(source, destination)).filter(
      ({ from }) => from.name === 'images',
    ),
  });

  await assert.rejects(pipeline.run(), (error: Error) => {
    assert.match(String(error.cause), /unknown encoding \(first byte 3\)/);
    return true;
  });
  assert.deepEqual(
    rows(
      destination.path,
      "SELECT name FROM sqlite_schema WHERE name = 'images'",
    ),
    [],
  );
});

test('a Contacts watch loads each commit contactsd makes and each account added', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  const source = new AppleContactsSource(directory, 20);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: (await copies(source, destination)).filter(
      ({ from }) => from.name === 'contacts',
    ),
  });
  // contactsd holds its connections, and so the WALs, open the whole time.
  using contactsd = new DatabaseSync(
    join(directory, 'Sources/ACCOUNT-A/AddressBook-v22.abcddb'),
  );
  const controller = new AbortController();
  const batches: number[] = [];

  for await (const results of pipeline.watch({ signal: controller.signal })) {
    batches.push(results[0]?.count ?? -1);
    if (batches.length === 1)
      contactsd.exec(
        `INSERT INTO ZABCDRECORD (Z_ENT, ZUNIQUEID, ZCONTAINER1, ZFIRSTNAME) VALUES (${contact}, 'NEW:ABPerson', 1, 'New')`,
      );
    else if (batches.length === 2)
      createStore(join(directory, 'Sources/ACCOUNT-C'), {
        ZABCDRECORD: [
          { Z_PK: 1, Z_ENT: container, ZUNIQUEID: 'C:ABContainer' },
          {
            Z_PK: 2,
            Z_ENT: contact,
            ZUNIQUEID: 'CAROL:ABPerson',
            ZCONTAINER1: 1,
          },
        ],
      });
    else setTimeout(() => controller.abort(), 200);
  }

  assert.deepEqual(batches, [4, 1, 1]);
});

test('the Contacts exporter loads every stream end to end and a second run writes nothing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-contacts-'),
  );
  const directory = addressBookFixture(join(scratch.path, 'AddressBook'));
  const out = join(scratch.path, 'out');
  const exporter = fileURLToPath(new URL('./contacts.js', import.meta.url));
  const run = () =>
    execFile(process.execPath, [
      exporter,
      '--address-book',
      directory,
      '--out',
      out,
    ]);
  const database = join(out, 'apple-contacts.sqlite');
  const tables = () =>
    rows(
      database,
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'raw_%' ORDER BY name",
    ).map(
      ({ name }) =>
        rows(
          database,
          `SELECT '${String(name)}' AS name, count(*) AS rows, max(loaded_at) AS loadedAt FROM "${String(name)}"`,
        )[0],
    );

  const first = await run();
  const loaded = tables();
  const second = await run();

  assert.match(first.stdout, /Loaded Apple Contacts/);
  assert.equal(loaded.length, 24);
  assert.deepEqual(
    loaded
      .filter(
        (table) =>
          table?.name === 'raw_contacts' || table?.name === 'raw_images',
      )
      .map((table) => [table?.name, table?.rows]),
    [
      ['raw_contacts', 4],
      ['raw_images', 3],
    ],
  );
  assert.match(second.stdout, /Loaded Apple Contacts/);
  assert.deepEqual(tables(), loaded);
});
