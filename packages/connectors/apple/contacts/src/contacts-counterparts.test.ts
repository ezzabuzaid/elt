import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { Settings } from '@workspace/settings';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

// The SDK finds the address book and the global preferences under HOME when
// its module loads, so the connector is imported only after HOME points at
// the test's folder. node --test runs this file in its own process.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: ContactsConnector } =
      await import('./contacts-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Contacts reads nothing through EventKit.
    return new ContactsConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

// One pass as the hosts run it, from a saved selection into its import.
async function importAll(
  connector: AppleConnector,
  root: string,
): Promise<string> {
  using settings = new Settings(root);
  const selection = {
    connector: connector.name,
    scope: {},
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

const contact = 22;
const container = 25;

// One store at the address book's root, the On My Mac store, with no account
// stores beside it, and the Mac region in the global preferences.
function macUnder(
  home: string,
  locale: string,
  rows: Record<string, readonly Record<string, SQLInputValue>[]>,
): void {
  const directory = join(home, 'Library/Application Support/AddressBook');
  mkdirSync(join(directory, 'Sources'), { recursive: true });
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
  const preferences = join(home, 'Library/Preferences');
  mkdirSync(preferences, { recursive: true });
  writeFileSync(
    join(preferences, '.GlobalPreferences.plist'),
    execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
      input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>AppleLocale</key><string>${locale}</string></dict></plist>`,
    }),
  );
}

test('Contacts counterparts link each card to its numbers in E.164, its addresses and its short codes, and mark the card that is the user', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'contacts-counterparts-'),
  );
  macUnder(home.path, 'en_JO', {
    ZABCDRECORD: [
      {
        Z_PK: 1,
        Z_ENT: container,
        ZUNIQUEID: 'LOCAL:ABContainer',
        ZME: 2,
      },
      {
        Z_PK: 2,
        Z_ENT: contact,
        ZUNIQUEID: 'ME:ABPerson',
        ZCONTAINER1: 1,
        ZFIRSTNAME: 'Ezz',
        ZLASTNAME: 'Abuzaid',
      },
      {
        Z_PK: 3,
        Z_ENT: contact,
        ZUNIQUEID: 'RANA:ABPerson',
        ZCONTAINER1: 1,
        ZFIRSTNAME: 'Rana',
      },
      {
        Z_PK: 4,
        Z_ENT: contact,
        ZUNIQUEID: 'BANK:ABPerson',
        ZCONTAINER1: 1,
        ZORGANIZATION: 'Arab Bank',
      },
      {
        Z_PK: 5,
        Z_ENT: contact,
        ZUNIQUEID: 'EMPTY:ABPerson',
        ZCONTAINER1: 1,
        ZNICKNAME: 'Plumber',
      },
    ],
    ZABCDPHONENUMBER: [
      { ZOWNER: 2, ZUNIQUEID: 'P1', ZFULLNUMBER: '+962 79 000 0001' },
      { ZOWNER: 3, ZUNIQUEID: 'P2', ZFULLNUMBER: '079 123 4567' },
      { ZOWNER: 3, ZUNIQUEID: 'P3', ZFULLNUMBER: '00962 79 123 4567' },
      { ZOWNER: 4, ZUNIQUEID: 'P4', ZFULLNUMBER: '988 77' },
    ],
    ZABCDEMAILADDRESS: [
      { ZOWNER: 3, ZUNIQUEID: 'E1', ZADDRESS: ' Rana@Example.com ' },
    ],
  });
  const connector = await connectorUnder(home.path);

  const database = await importAll(connector, join(home.path, 'Apple'));

  assert.deepEqual(
    read(
      database,
      'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, occurrences, context FROM counterparts ORDER BY identifier, relation, linked_identifier',
    ),
    [
      // A short code has no E.164 form; its digits match an SMS sender.
      {
        relation: 'card',
        identifier_type: 'app',
        identifier: 'BANK:ABPerson',
        linked_type: 'app',
        linked_identifier: '98877',
        name: 'Arab Bank',
        first_at: null,
        occurrences: 1,
        context: null,
      },
      // A card with no number or address is still someone the user knows.
      {
        relation: 'card',
        identifier_type: 'app',
        identifier: 'EMPTY:ABPerson',
        linked_type: null,
        linked_identifier: null,
        name: 'Plumber',
        first_at: null,
        occurrences: 1,
        context: null,
      },
      {
        relation: 'card',
        identifier_type: 'app',
        identifier: 'ME:ABPerson',
        linked_type: 'phone',
        linked_identifier: '+962790000001',
        name: 'Ezz Abuzaid',
        first_at: null,
        occurrences: 1,
        context: null,
      },
      {
        relation: 'self',
        identifier_type: 'app',
        identifier: 'ME:ABPerson',
        linked_type: 'phone',
        linked_identifier: '+962790000001',
        name: 'Ezz Abuzaid',
        first_at: null,
        occurrences: 1,
        context: null,
      },
      // A local number and the same number with its international prefix
      // are one number; the address is trimmed and lowercase.
      {
        relation: 'card',
        identifier_type: 'app',
        identifier: 'RANA:ABPerson',
        linked_type: 'phone',
        linked_identifier: '+962791234567',
        name: 'Rana',
        first_at: null,
        occurrences: 1,
        context: null,
      },
      {
        relation: 'card',
        identifier_type: 'app',
        identifier: 'RANA:ABPerson',
        linked_type: 'email',
        linked_identifier: 'rana@example.com',
        name: 'Rana',
        first_at: null,
        occurrences: 1,
        context: null,
      },
    ],
  );
  // Readers find the view and every column described in the catalog.
  assert.equal(
    read(
      database,
      "SELECT count(*) AS n FROM catalog WHERE name LIKE 'counterparts.%' AND description <> ''",
    )[0]?.n,
    10,
  );
});
