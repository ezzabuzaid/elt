import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import type { AppleApp } from '@workspace/connector-apple-app/apple-app';
import CalendarApp from '@workspace/connector-apple-calendar';
import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory, installSQLiteCatalog } from '@workspace/elt-sqlite';
import type {
  AccountDocument,
  OccurrenceDocument,
  ParticipantDocument,
} from '@workspace/macos-eventkit';
import {
  FakeEventKitHelper,
  type HelperCalendarDocument,
} from '@workspace/macos-eventkit/test';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import osa from '@workspace/source-apple-macos/osa';

// The host the plugin's server passes its apps, with the helper this
// workspace compiled instead of the bundled copy.
const host = {
  grantee: 'Codex',
  eventKitHelper: fileURLToPath(
    new URL(
      'eventkit-helper',
      import.meta.resolve('@workspace/macos-eventkit'),
    ),
  ),
};

// The Apple plugin's meeting-prep skill tells the agent to read each app's
// import with these SQL blocks. Each test below imports an app the way the
// plugin does and runs the skill's own text, so a connector change that breaks
// a query fails here instead of in a user's meeting brief.
const skill = readFileSync(
  resolve(
    import.meta.dirname,
    '../../../..',
    'plugins/apple/skills/meeting-prep/SKILL.md',
  ),
  'utf8',
);

// The skill's SQL blocks, indented under list items in the Markdown.
const blocks = [...skill.matchAll(/^( *)```sql\n([\s\S]*?)^\1```$/gm)].map(
  ([, indent = '', body = '']) =>
    body.replaceAll(new RegExp(`^${indent}`, 'gm'), ''),
);

// The block that reads what fragment names, such as its FROM clause.
const query = (fragment: string) => {
  const [block, ...others] = blocks.filter((sql) => sql.includes(fragment));
  assert.ok(block, `a meeting-prep query has ${fragment}`);
  assert.deepEqual(others, [], `only one meeting-prep query has ${fragment}`);
  return block;
};

const reads = {
  meetings: 'FROM events e JOIN calendars c',
  previous: 'WHERE e.externalId = @series',
  contact: 'FROM email_addresses e JOIN contacts c',
  notes: 'FROM notes n JOIN folders f',
  messages: 'JOIN chat_handles ch',
  mail: 'WITH person AS (SELECT id FROM addresses',
  mailSubjects: "WHERE s.subject LIKE '%' || @term || '%'",
} as const;

// Imports an app whose store lives under the user's home: the app reads its
// path when its module loads, so HOME points at the test's own folder first.
// node --test runs this file in its own process and each test imports a
// different app, so every app module loads once, under its test's HOME.
async function withHome<T>(home: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

test('every SQL block in the meeting-prep skill is one of the queries this file reads', () => {
  const matched = blocks.map((block) =>
    Object.entries(reads)
      .filter(([, fragment]) => block.includes(fragment))
      .map(([name]) => name),
  );

  for (const [index, names] of matched.entries())
    assert.equal(names.length, 1, `SQL block ${index + 1} is one tested query`);
  assert.deepEqual(matched.flat().toSorted(), Object.keys(reads).toSorted());
});

// Runs one query as the skill tells the agent to: the macOS sqlite3 shell,
// read-only, with parameters bound through -cmd. A failing query fails the
// test rather than reading as no rows.
function read(
  database: string,
  sql: string,
  parameters: Record<string, string | number> = {},
): Record<string, unknown>[] {
  const bind = Object.entries(parameters).flatMap(([name, value]) => [
    '-cmd',
    typeof value === 'number'
      ? `.parameter set ${name} ${value}`
      : `.parameter set ${name} "'${value.replaceAll("'", "''")}'"`,
  ]);
  const result = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      '-cmd',
      '.timeout 30000',
      '-cmd',
      'PRAGMA temp_store = MEMORY',
      ...bind,
      database,
      sql,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout || '[]');
}

// An app's import as the plugin builds one: its connection into a directory
// with the app's default scope, sync history and catalog installed, then one
// pass. The plugin keeps it current with watch(); run() is that first pass,
// and it fails on any copy error, so a broken import cannot read as an empty
// one.
async function importApp(
  app: AppleApp,
  directory: string,
  scope: ImportScope = app.defaultScope(),
): Promise<string> {
  const { connection, destination } = await app.connection(directory, {
    app: app.name,
    scope,
    includeAttachments: false,
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog(destination);
  await new Pipeline({ connections: [connection], history }).run();
  return join(directory, 'data.sqlite');
}

const account: AccountDocument = {
  name: 'Default',
  sourceType: 0,
  id: 'account-1',
  type: 'account',
  isDelegate: false,
};

const calendar = (
  overrides: Partial<HelperCalendarDocument> = {},
): HelperCalendarDocument => ({
  color: [0.8, 0.2, 0.9, 1],
  name: 'Work',
  type: 'calendar',
  id: 'calendar-1',
  selected: true,
  allowedEntityTypes: 1,
  subscribed: false,
  immutable: false,
  writable: true,
  calendarType: 1,
  supportedAvailabilities: 0,
  accountId: 'account-1',
  ...overrides,
});

const participant = (
  overrides: Partial<ParticipantDocument> = {},
): ParticipantDocument => ({
  name: 'Ann',
  url: 'mailto:ann@example.com',
  status: 2,
  role: 1,
  participantType: 1,
  isCurrentUser: false,
  ...overrides,
});

const minute = 60_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// A timed occurrence starting at startMs for an hour, written as the helper
// writes one.
const occurrence = (
  startMs: number,
  overrides: Partial<OccurrenceDocument> = {},
): OccurrenceDocument => ({
  type: 'occurrence',
  calendarId: 'calendar-1',
  calendarItemId: 'item-1',
  nativeEventId: 'account-1:external-1',
  externalId: 'external-1',
  name: 'Standup',
  timeZone: 'UTC',
  allDay: false,
  startMs,
  endMs: startMs + 60 * minute,
  occurrenceMs: startMs,
  startDay: day(startMs),
  endDay: day(startMs + 60 * minute),
  occurrenceDay: day(startMs),
  createdMs: startMs - 30 * 24 * 60 * minute,
  modifiedMs: startMs - 30 * 24 * 60 * minute,
  availability: -1,
  status: 0,
  detached: false,
  alarms: [],
  attendees: [],
  recurrenceRules: [],
  ...overrides,
});

test('meeting prep finds the next meetings in own calendars, with who is coming, and the series last occurrence', async (t) => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'meeting-prep-calendar-'),
  );
  const now = Math.ceil(Date.now() / minute) * minute;
  const weekly = {
    interval: 1,
    frequency: 1,
    firstDayOfWeek: 2,
    calendarIdentifier: 'gregorian',
    daysOfTheWeek: [],
    daysOfTheMonth: [],
    daysOfTheYear: [],
    monthsOfTheYear: [],
    weeksOfTheYear: [],
    setPositions: [],
  };
  const app = new CalendarApp(host);
  const scope = app.defaultScope();
  const { startAt, endAt } = scope;
  new FakeEventKitHelper()
    .answer({ entity: 'events', startAt, endAt, ics: true }, () => [
      account,
      calendar(),
      calendar({
        id: 'calendar-2',
        name: 'Prayer times',
        subscribed: true,
        calendarType: 1,
        writable: false,
      }),
      occurrence(now - 7 * 24 * 60 * minute, {
        recurrenceRules: [weekly],
        body: 'Last week: Ann owes the budget numbers.',
      }),
      occurrence(now + 10 * minute, {
        recurrenceRules: [weekly],
        attendees: [
          participant(),
          participant({
            name: 'Me',
            url: 'mailto:me@example.com',
            isCurrentUser: true,
          }),
          participant({
            name: 'Room 4',
            url: 'mailto:room4@example.com',
            participantType: 2,
          }),
        ],
      }),
      occurrence(now + 5 * minute, {
        calendarId: 'calendar-2',
        calendarItemId: 'prayer',
        externalId: 'prayer',
        nativeEventId: 'account-1:prayer',
        name: 'Asr',
      }),
      occurrence(now + 12 * minute, {
        calendarItemId: 'canceled',
        externalId: 'canceled',
        nativeEventId: 'account-1:canceled',
        name: 'Canceled review',
        status: 3,
      }),
      occurrence(now + 15 * minute, {
        calendarId: 'calendar-2',
        calendarItemId: 'invite',
        externalId: 'invite',
        nativeEventId: 'account-1:invite',
        name: 'Invite on a subscribed calendar',
        attendees: [participant({ name: 'Bo', url: 'mailto:bo@example.com' })],
      }),
      occurrence(now + 8 * minute, {
        calendarItemId: 'offsite',
        externalId: 'offsite',
        nativeEventId: 'account-1:offsite',
        name: 'All-day offsite',
        allDay: true,
      }),
      occurrence(now + 18 * minute, {
        calendarItemId: 'focus',
        externalId: 'focus',
        nativeEventId: 'account-1:focus',
        name: 'Budget prep',
      }),
      occurrence(now + 26 * 60 * minute, {
        calendarItemId: 'tomorrow',
        externalId: 'tomorrow',
        nativeEventId: 'account-1:tomorrow',
        name: 'Tomorrow sync',
      }),
      occurrence(now + 45 * minute, {
        calendarItemId: 'later',
        externalId: 'later',
        nativeEventId: 'account-1:later',
        name: 'Later today',
      }),
    ])
    .install(t);
  const database = await importApp(app, join(scratch.path, 'calendar'), scope);

  const meetings = read(database, query(reads.meetings), { '@minutes': 20 });

  assert.deepEqual(
    meetings.map(({ name, startAt }) => [name, startAt]),
    [
      ['Standup', new Date(now + 10 * minute).toISOString()],
      [
        'Invite on a subscribed calendar',
        new Date(now + 15 * minute).toISOString(),
      ],
      ['Budget prep', new Date(now + 18 * minute).toISOString()],
    ],
  );
  const [standup] = meetings;
  assert.deepEqual(JSON.parse(String(standup?.attendees)), [
    {
      name: 'Ann',
      email: 'ann@example.com',
      kind: 'attendee',
      status: 2,
      role: 1,
    },
  ]);
  assert.deepEqual(
    read(database, query(reads.previous), {
      '@series': String(standup?.externalId),
    }).map(({ name, body }) => [name, body]),
    [['Standup', 'Last week: Ann owes the budget numbers.']],
  );

  // The skill's other two ways to find meetings edit the same query.
  const window =
    "AND e.startAt < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || @minutes || ' minutes')";
  const restOfToday = /replaced by `(AND e\.startAt < [^`]+)`/.exec(skill)?.[1];
  const named = /with `(AND e\.name LIKE [^`]+)` added/.exec(skill)?.[1];
  assert.ok(restOfToday && named);
  assert.ok(query(reads.meetings).includes(window));
  const today = new Date(now).toDateString();
  assert.deepEqual(
    read(database, query(reads.meetings).replace(window, restOfToday)).map(
      ({ name }) => name,
    ),
    [
      ['Standup', 10],
      ['Invite on a subscribed calendar', 15],
      ['Budget prep', 18],
      ['Later today', 45],
      ['Tomorrow sync', 26 * 60],
    ]
      .filter(
        ([, after]) =>
          new Date(now + Number(after) * minute).toDateString() === today,
      )
      .map(([name]) => name),
  );
  assert.deepEqual(
    read(
      database,
      query(reads.meetings).replace(
        'ORDER BY e.startAt',
        `${named}\nORDER BY e.startAt`,
      ),
      { '@minutes': 60, '@title': 'Budget' },
    ).map(({ name }) => name),
    ['Budget prep'],
  );
});

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

// One AddressBook store with the given rows, as Contacts writes the On My Mac
// store.
function addressBook(
  directory: string,
  rows: Record<string, readonly Record<string, string | number>[]>,
) {
  mkdirSync(directory, { recursive: true });
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

test('meeting prep finds who an attendee is in Contacts by their email, whatever its case', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'meeting-prep-contacts-'),
  );
  // The On My Mac store, beside the account stores Contacts keeps in Sources.
  const addressBookDirectory = join(
    scratch.path,
    'Library/Application Support/AddressBook',
  );
  mkdirSync(join(addressBookDirectory, 'Sources'), { recursive: true });
  addressBook(addressBookDirectory, {
    ZABCDRECORD: [
      { Z_PK: 1, Z_ENT: 25, ZUNIQUEID: 'LOCAL:ABContainer', ZTYPE: 0 },
      {
        Z_PK: 2,
        Z_ENT: 22,
        ZUNIQUEID: 'ANN:ABPerson',
        ZCONTAINER1: 1,
        ZFIRSTNAME: 'Ann',
        ZLASTNAME: 'Lee',
        ZORGANIZATION: 'Acme',
        ZJOBTITLE: 'Finance lead',
      },
      {
        Z_PK: 3,
        Z_ENT: 22,
        ZUNIQUEID: 'BO:ABPerson',
        ZCONTAINER1: 1,
        ZFIRSTNAME: 'Bo',
      },
    ],
    ZABCDEMAILADDRESS: [
      { Z_PK: 1, ZOWNER: 2, ZUNIQUEID: 'EMAIL-1', ZADDRESS: 'Ann@Example.com' },
      { Z_PK: 2, ZOWNER: 3, ZUNIQUEID: 'EMAIL-2', ZADDRESS: 'bo@example.com' },
    ],
    ZABCDPHONENUMBER: [
      {
        Z_PK: 1,
        ZOWNER: 2,
        ZUNIQUEID: 'PHONE-1',
        ZFULLNUMBER: '+962 79 123 4567',
      },
    ],
  });
  const database = await withHome(scratch.path, async () => {
    const { default: ContactsApp } =
      await import('@workspace/connector-apple-contacts');
    return importApp(new ContactsApp(host), join(scratch.path, 'contacts'));
  });

  const cards = read(database, query(reads.contact), {
    '@email': 'ann@example.com',
  });

  assert.deepEqual(cards, [
    {
      firstName: 'Ann',
      lastName: 'Lee',
      organization: 'Acme',
      jobTitle: 'Finance lead',
      phones: '["+962 79 123 4567"]',
    },
  ]);
});

// NoteStore.sqlite's tables as macOS 26.6.2 creates them (schema only, no
// data), in WAL mode like the real store.
const noteStoreSchema = `PRAGMA journal_mode = WAL;
CREATE TABLE ZICCLOUDSYNCINGOBJECT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCRYPTOITERATIONCOUNT INTEGER, ZHASMISSINGKEYCHAINITEM INTEGER, ZISPASSWORDPROTECTED INTEGER, ZISRECOVERINGFROMTRASH INTEGER, ZISSHAREDIRTY INTEGER, ZMARKEDFORDELETION INTEGER, ZMINIMUMSUPPORTEDNOTESVERSION INTEGER, ZNEEDSINITIALFETCHFROMCLOUD INTEGER, ZNEEDSTOBEFETCHEDFROMCLOUD INTEGER, ZNEEDSTOFETCHUSERSPECIFICRECORDASSETS INTEGER, ZNEEDSTOSAVEUSERSPECIFICRECORD INTEGER, ZNEEDSTOUPDATEUSERSPECIFICRECORDREFERENCEACTIONS INTEGER, ZCLOUDSTATE INTEGER, ZINVITATION INTEGER, ZLOCKEDNOTESMODE INTEGER, ZSUPPORTSV1NEO INTEGER, ZACCOUNT INTEGER, ZCHECKEDFORLOCATION INTEGER, ZDIDRUNPAPERFORMDETECTION INTEGER, ZFILESIZE INTEGER, ZHANDWRITINGSUMMARYVERSION INTEGER, ZHASMARKUPDATA INTEGER, ZHASPAPERFORM INTEGER, ZIMAGECLASSIFICATIONSUMMARYVERSION INTEGER, ZIMAGEFILTERTYPE INTEGER, ZNEEDSINITIALRELATIONSHIPSETUP INTEGER, ZNEEDSTRANSCRIPTION INTEGER, ZOCRSUMMARYVERSION INTEGER, ZORIENTATION INTEGER, ZSECTION INTEGER, ZURLEXPIRED INTEGER, ZACCOUNT1 INTEGER, ZLOCATION INTEGER, ZMEDIA INTEGER, ZNOTE INTEGER, ZNOTEUSINGTITLEFORNOTETITLE INTEGER, ZPARENTATTACHMENT INTEGER, ZAPPEARANCETYPE INTEGER, ZSCALEWHENDRAWING INTEGER, ZVERSION INTEGER, ZVERSIONOUTOFDATE INTEGER, ZATTACHMENT INTEGER, ZSTATE INTEGER, ZACCOUNT2 INTEGER, ZACCOUNT3 INTEGER, ZMENTIONNOTIFICATIONATTEMPTCOUNT INTEGER, ZMENTIONNOTIFICATIONSTATE INTEGER, ZACCOUNT4 INTEGER, ZNOTE1 INTEGER, ZPARENTATTACHMENT1 INTEGER, ZTYPE INTEGER, ZACCOUNT5 INTEGER, ZACCOUNT6 INTEGER, ZATTACHMENT1 INTEGER, ZATTACHMENTVIEWTYPE INTEGER, ZHASCHECKLIST INTEGER, ZHASCHECKLISTINPROGRESS INTEGER, ZHASEMPHASIS INTEGER, ZHASSYSTEMTEXTATTACHMENTS INTEGER, ZISPINNED INTEGER, ZISSYSTEMPAPER INTEGER, ZLEGACYNOTEWASPLAINTEXT INTEGER, ZNOTEHASCHANGES INTEGER, ZPAPERSTYLETYPE INTEGER, ZPREFERREDBACKGROUNDTYPE INTEGER, ZACCOUNT7 INTEGER, ZFOLDER INTEGER, ZNOTEDATA INTEGER, ZTITLESOURCEATTACHMENT INTEGER, ZDATEHEADERSTYPE INTEGER, ZSORTORDER INTEGER, ZOWNER INTEGER, ZACCOUNTTYPE INTEGER, ZDIDCHOOSETOMIGRATE INTEGER, ZDIDFINISHMIGRATION INTEGER, ZDIDMIGRATEONMAC INTEGER, ZSERVERSIDEUPDATETASKFAILURECOUNT INTEGER, ZSTOREDATASEPARATELY INTEGER, ZACCOUNTDATA INTEGER, ZCUSTOMNOTESORTTYPEVALUE INTEGER, ZFOLDERTYPE INTEGER, ZIMPORTEDFROMLEGACY INTEGER, ZACCOUNT8 INTEGER, ZPARENT INTEGER, ZCREATIONDATE TIMESTAMP, ZCROPPINGQUADBOTTOMLEFTX FLOAT, ZCROPPINGQUADBOTTOMLEFTY FLOAT, ZCROPPINGQUADBOTTOMRIGHTX FLOAT, ZCROPPINGQUADBOTTOMRIGHTY FLOAT, ZCROPPINGQUADTOPLEFTX FLOAT, ZCROPPINGQUADTOPLEFTY FLOAT, ZCROPPINGQUADTOPRIGHTX FLOAT, ZCROPPINGQUADTOPRIGHTY FLOAT, ZDURATION FLOAT, ZMODIFICATIONDATE TIMESTAMP, ZORIGINX FLOAT, ZORIGINY FLOAT, ZPREVIEWUPDATEDATE TIMESTAMP, ZSIZEHEIGHT FLOAT, ZSIZEWIDTH FLOAT, ZHEIGHT FLOAT, ZMODIFIEDDATE TIMESTAMP, ZSCALE FLOAT, ZWIDTH FLOAT, ZSTATEMODIFICATIONDATE TIMESTAMP, ZCREATIONDATE1 TIMESTAMP, ZCREATIONDATE2 TIMESTAMP, ZMODIFICATIONDATEATIMPORT TIMESTAMP, ZCREATIONDATE3 TIMESTAMP, ZFOLDERMODIFICATIONDATE TIMESTAMP, ZLASTACTIVITYRECENTUPDATESVIEWEDDATE TIMESTAMP, ZLASTACTIVITYSUMMARYVIEWEDDATE TIMESTAMP, ZLASTATTRIBUTIONSVIEWEDDATE TIMESTAMP, ZLASTNOTIFIEDDATE TIMESTAMP, ZLASTOPENEDDATE TIMESTAMP, ZLASTVIEWEDMODIFICATIONDATE TIMESTAMP, ZLEGACYMODIFICATIONDATEATIMPORT TIMESTAMP, ZMODIFICATIONDATE1 TIMESTAMP, ZLASTSYNCDATE TIMESTAMP, ZCUSTOMNOTESORTTYPEMODIFICATIONDATE TIMESTAMP, ZDATEFORLASTTITLEMODIFICATION TIMESTAMP, ZPARENTMODIFICATIONDATE TIMESTAMP, ZIDENTIFIER VARCHAR, ZPASSWORDHINT VARCHAR, ZZONEOWNERNAME VARCHAR, ZADDITIONALINDEXABLETEXT VARCHAR, ZFALLBACKIMAGEGENERATION VARCHAR, ZFALLBACKPDFGENERATION VARCHAR, ZFALLBACKSUBTITLEIOS VARCHAR, ZFALLBACKSUBTITLEMAC VARCHAR, ZFALLBACKTITLE VARCHAR, ZHANDWRITINGSUMMARY VARCHAR, ZIMAGECLASSIFICATIONSUMMARY VARCHAR, ZOCRSUMMARY VARCHAR, ZPAPERBUNDLEGENERATION VARCHAR, ZREMOTEFILEURLSTRING VARCHAR, ZSUMMARY VARCHAR, ZTITLE VARCHAR, ZTYPEUTI VARCHAR, ZURLSTRING VARCHAR, ZUSERTITLE VARCHAR, ZGENERATION VARCHAR, ZDEVICEIDENTIFIER VARCHAR, ZDISPLAYTEXT VARCHAR, ZSTANDARDIZEDCONTENT VARCHAR, ZALTTEXT VARCHAR, ZTOKENCONTENTIDENTIFIER VARCHAR, ZTYPEUTI1 VARCHAR, ZCONTENTHASHATIMPORT VARCHAR, ZFILENAME VARCHAR, ZGENERATION1 VARCHAR, ZHOSTAPPLICATIONIDENTIFIER VARCHAR, ZLEGACYCONTENTHASHATIMPORT VARCHAR, ZLEGACYIMPORTDEVICEIDENTIFIER VARCHAR, ZLEGACYMANAGEDOBJECTIDURIREPRESENTATION VARCHAR, ZSELECTEDINKCOLORSTRING VARCHAR, ZSELECTEDINKIDENTIFIER VARCHAR, ZSNIPPET VARCHAR, ZTHUMBNAILATTACHMENTIDENTIFIER VARCHAR, ZTITLE1 VARCHAR, ZWIDGETSNIPPET VARCHAR, ZACCOUNTNAMEFORACCOUNTLISTSORTING VARCHAR, ZNESTEDTITLEFORSORTING VARCHAR, ZNAME VARCHAR, ZSERVERSIDEUPDATETASKLASTATTEMPTEDBUILD VARCHAR, ZSERVERSIDEUPDATETASKLASTATTEMPTEDVERSION VARCHAR, ZSERVERSIDEUPDATETASKLASTCOMPLETEDBUILD VARCHAR, ZSERVERSIDEUPDATETASKLASTCOMPLETEDVERSION VARCHAR, ZUSERRECORDNAME VARCHAR, ZSMARTFOLDERQUERYJSON VARCHAR, ZTITLE2 VARCHAR, ZATTRIBUTEDSNIPPET BLOB, ZATTRIBUTEDTITLE BLOB, ZREPLICAIDTOBUNDLEIDENTIFIER BLOB, ZACTIVITYEVENTSDATA BLOB, ZASSETCRYPTOINITIALIZATIONVECTOR BLOB, ZASSETCRYPTOTAG BLOB, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOSALT BLOB, ZCRYPTOTAG BLOB, ZCRYPTOWRAPPEDKEY BLOB, ZENCRYPTEDVALUESJSON BLOB, ZREPLICAIDTONOTESVERSIONDATA BLOB, ZSERVERRECORDDATA BLOB, ZSERVERSHAREDATA BLOB, ZUNAPPLIEDENCRYPTEDRECORDDATA BLOB, ZUSERSPECIFICSERVERRECORDDATA BLOB, ZCRYPTOPASSPHRASEVERIFIER BLOB, ZMERGEABLEDATA BLOB, ZFALLBACKIMAGECRYPTOINITIALIZATIONVECTOR BLOB, ZFALLBACKIMAGECRYPTOTAG BLOB, ZFALLBACKPDFCRYPTOINITIALIZATIONVECTOR BLOB, ZFALLBACKPDFCRYPTOTAG BLOB, ZLINKPRESENTATIONARCHIVEDMETADATA BLOB, ZMARKUPMODELDATA BLOB, ZMERGEABLEDATA1 BLOB, ZMERGEABLEPREFERREDVIEWSIZE BLOB, ZMETADATADATA BLOB, ZSYNAPSEDATA BLOB, ZTEMPORARYTRANSCRIPTDATA BLOB, ZCRYPTOMETADATAINITIALIZATIONVECTOR BLOB, ZCRYPTOMETADATATAG BLOB, ZENCRYPTEDMETADATA BLOB, ZMETADATA BLOB, ZLASTNOTIFIEDTIMESTAMPDATA BLOB, ZLASTVIEWEDTIMESTAMPDATA BLOB, ZOUTLINESTATEDATA BLOB, ZREPLICAIDTOUSERIDDICTDATA BLOB, ZCRYPTOVERIFIER BLOB, ZSERVERSIDEUPDATETASKCONTINUATIONTOKEN BLOB, ZMERGEABLEDATA2 BLOB );
CREATE TABLE ZICLOCATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPLACEUPDATED INTEGER, ZATTACHMENT INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZPLACEMARKDATA BLOB );
CREATE TABLE ZICNOTEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNOTE INTEGER, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOTAG BLOB, ZDATA BLOB );
CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);`;

// Entities as the real store numbers them in Z_PRIMARYKEY.
const noteEntities = {
  ICAccount: 14,
  ICAttachment: 5,
  ICFolder: 15,
  ICInlineAttachment: 9,
  ICMedia: 11,
  ICNote: 12,
} as const;

// A plain-text note body as Notes stores it: versioned_document.Document >
// Version > topotext.String { string, one attribute run }, gzipped.
const noteBody = (text: string) => {
  const varint = (value: number): number[] => {
    const bytes: number[] = [];
    let rest = value;
    while (rest > 0x7f) {
      bytes.push((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(rest);
    return bytes;
  };
  const number = (field: number, value: number) => [
    ...varint(field << 3),
    ...varint(value),
  ];
  const bytes = (field: number, value: string | number[]) => {
    const content =
      typeof value === 'string' ? [...Buffer.from(value, 'utf8')] : value;
    return [...varint((field << 3) | 2), ...varint(content.length), ...content];
  };
  const string = [...bytes(2, text), ...bytes(5, number(1, text.length))];
  return gzipSync(
    Uint8Array.from(bytes(2, [...number(1, 0), ...bytes(3, string)])),
  );
};

// Core Data dates: seconds since 2001-01-01.
const coreDataSeconds = (ms: number) => (ms - Date.UTC(2001, 0, 1)) / 1000;

test('meeting prep finds notes that mention a meeting, leaving out Recently Deleted', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'meeting-prep-notes-'),
  );
  const store = join(
    scratch.path,
    'Library/Group Containers/group.com.apple.notes',
  );
  mkdirSync(store, { recursive: true });
  {
    using notes = new DatabaseSync(join(store, 'NoteStore.sqlite'));
    notes.exec(noteStoreSchema);
    const entity = notes.prepare(
      'INSERT INTO Z_PRIMARYKEY (Z_ENT, Z_NAME) VALUES (?, ?)',
    );
    for (const [name, id] of Object.entries(noteEntities)) entity.run(id, name);
    const day = coreDataSeconds(Date.now() - 24 * 60 * 60_000);
    notes.exec(`
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZNAME, ZACCOUNTTYPE) VALUES (1, 14, 'ACCOUNT-1', 'iCloud', 1);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE2, ZACCOUNT8, ZFOLDERTYPE) VALUES
        (2, 15, 'FOLDER-NOTES', 'Notes', 1, 0),
        (3, 15, 'FOLDER-TRASH', 'Recently Deleted', 1, 1);
      INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTITLE1, ZFOLDER, ZACCOUNT7, ZNOTEDATA, ZCREATIONDATE3, ZMODIFICATIONDATE1, ZISPINNED, ZISPASSWORDPROTECTED, ZHASCHECKLIST, ZHASCHECKLISTINPROGRESS) VALUES
        (4, 12, 'NOTE-AGENDA', 'Standup agenda', 2, 1, 1, ${day}, ${day}, 0, 0, 0, 0),
        (5, 12, 'NOTE-TRASHED', 'Old standup', 3, 1, 2, ${day}, ${day}, 0, 0, 0, 0),
        (6, 12, 'NOTE-OTHER', 'Groceries', 2, 1, 3, ${day}, ${day}, 0, 0, 0, 0);
    `);
    const data = notes.prepare(
      'INSERT INTO ZICNOTEDATA (Z_PK, ZNOTE, ZDATA) VALUES (?, ?, ?)',
    );
    data.run(
      1,
      4,
      noteBody('Standup agenda\nAsk Ann for the budget numbers\n'),
    );
    data.run(2, 5, noteBody('Old standup\nthrown away\n'));
    data.run(3, 6, noteBody('Groceries\nMilk\n'));
  }
  const database = await withHome(scratch.path, async () => {
    const { default: NotesApp } =
      await import('@workspace/connector-apple-notes');
    return importApp(new NotesApp(host), join(scratch.path, 'notes'));
  });

  const byTitle = read(database, query(reads.notes), { '@term': 'standup' });
  const byPerson = read(database, query(reads.notes), { '@term': 'Ann' });

  assert.deepEqual(
    byTitle.map(({ title }) => title),
    ['Standup agenda'],
  );
  assert.deepEqual(
    byPerson.map(({ title, excerpt }) => [title, excerpt]),
    [['Standup agenda', 'Standup agenda\nAsk Ann for the budget numbers']],
  );
});

// A chat.db with Messages' own table definitions, captured from macOS 26.6.2
// (schema only, no data), in WAL mode like the real file.
const chatSchema = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER, engram_id TEXT, server_change_token TEXT, ck_sync_state INTEGER DEFAULT 0, original_group_id TEXT, last_read_message_timestamp INTEGER DEFAULT 0, cloudkit_record_id TEXT, last_addressed_sim_id TEXT, is_blackholed INTEGER DEFAULT 0, syndication_date INTEGER DEFAULT 0, syndication_type INTEGER DEFAULT 0, is_recovered INTEGER DEFAULT 0, is_deleting_incoming_messages INTEGER DEFAULT 0, is_pending_review INTEGER DEFAULT 0);
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service) );
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0, is_forward INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0, is_archive INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT, was_data_detected INTEGER DEFAULT 0, was_deduplicated INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, date_played INTEGER, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0, message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0, associated_message_range_length INTEGER DEFAULT 0, time_expressive_send_played INTEGER, message_summary_info BLOB, ck_sync_state INTEGER DEFAULT 0, ck_record_id TEXT, ck_record_change_tag TEXT, destination_caller_id TEXT, is_corrupt INTEGER DEFAULT 0, reply_to_guid TEXT, sort_id INTEGER, is_spam INTEGER DEFAULT 0, has_unseen_mention INTEGER DEFAULT 0, thread_originator_guid TEXT, thread_originator_part TEXT, syndication_ranges TEXT, synced_syndication_ranges TEXT, was_delivered_quietly INTEGER DEFAULT 0, did_notify_recipient INTEGER DEFAULT 0, date_retracted INTEGER, date_edited INTEGER, was_detonated INTEGER DEFAULT 0, part_count INTEGER, is_stewie INTEGER DEFAULT 0, is_sos INTEGER DEFAULT 0, is_critical INTEGER DEFAULT 0, bia_reference_id TEXT, is_kt_verified INTEGER DEFAULT 0, fallback_hash TEXT, associated_message_emoji TEXT, is_pending_satellite_send INTEGER DEFAULT 0, needs_relay INTEGER DEFAULT 0, schedule_type INTEGER DEFAULT 0, schedule_state INTEGER DEFAULT 0, sent_or_received_off_grid INTEGER DEFAULT 0, date_recovered INTEGER DEFAULT 0, is_time_sensitive INTEGER DEFAULT 0, ck_chat_id TEXT, index_state INTEGER DEFAULT 0);
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB, attribution_info BLOB, hide_attachment INTEGER DEFAULT 0, ck_sync_state INTEGER DEFAULT 0, ck_server_change_token_blob BLOB, ck_record_id TEXT, original_guid TEXT UNIQUE NOT NULL, is_commsafety_sensitive INTEGER DEFAULT 0, emoji_image_content_identifier TEXT, emoji_image_short_description TEXT, preview_generation_state INTEGER DEFAULT 0);
  CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, index_state INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
  CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
  CREATE TABLE chat_recoverable_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, delete_date INTEGER, ck_sync_state INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id), CHECK (delete_date != 0));
  CREATE TABLE recoverable_message_part (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, part_index INTEGER, delete_date INTEGER, part_text BLOB NOT NULL, ck_sync_state INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id, part_index), CHECK (delete_date != 0));
  CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER NOT NULL REFERENCES chat(ROWID) ON UPDATE CASCADE ON DELETE CASCADE, priority INTEGER DEFAULT 0, UNIQUE (identifier, domain));
  CREATE TABLE chat_service (service TEXT NOT NULL, chat INTEGER NOT NULL REFERENCES chat(ROWID) ON UPDATE CASCADE ON DELETE CASCADE, UNIQUE (service, chat));
`;

// An NSAttributedString in typedstream form, as Messages archives a body it
// keeps out of the text column.
const archivedText = (text: string) => {
  const bytes = Buffer.from(text);
  const length =
    bytes.length < 0x80
      ? [bytes.length]
      : [0x81, bytes.length & 0xff, bytes.length >> 8];
  return Buffer.concat([
    Buffer.from(
      '\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+',
      'latin1',
    ),
    Buffer.from(length),
    bytes,
    Buffer.from('\x86\x84\x02iI\x01', 'latin1'),
  ]);
};

// Nanoseconds since 2001-01-01 UTC, Messages' modern time unit.
const appleNanoseconds = (ms: number) =>
  BigInt(ms - Date.UTC(2001, 0, 1)) * 1_000_000n;

test('meeting prep finds recent messages with an attendee by email, or by their Contacts number in any format', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'meeting-prep-messages-'),
  );
  const directory = join(scratch.path, 'Library/Messages');
  mkdirSync(directory, { recursive: true });
  const now = Date.now();
  const daysAgo = (days: number) =>
    appleNanoseconds(now - days * 24 * 60 * 60_000);
  {
    using chat = new DatabaseSync(join(directory, 'chat.db'));
    chat.exec(chatSchema);
    chat.exec(`
      INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, style) VALUES
        (1, 'iMessage;-;+962791234567', '+962791234567', 'iMessage', '', 45),
        (2, 'SMS;-;0791234567', '0791234567', 'SMS', '', 45),
        (3, 'iMessage;-;ann@example.com', 'ann@example.com', 'iMessage', '', 45),
        (4, 'iMessage;-;+15550100', '+15550100', 'iMessage', '', 45),
        (5, 'SMS;-;+962791234567', '+962791234567', 'SMS', '', 45);
      INSERT INTO handle VALUES
        (1, '+962791234567', 'JO', 'iMessage', '0791234567', 'person-1'),
        (2, '0791234567', 'JO', 'SMS', '0791234567', 'person-1'),
        (3, 'ann@example.com', NULL, 'iMessage', 'Ann@Example.com', 'person-1'),
        (4, '+15550100', 'US', 'iMessage', '5550100', 'person-2'),
        (5, '+962791234567', 'JO', 'SMS', '0791234567', 'person-1');
      INSERT INTO chat_handle_join VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 5);
    `);
    const insert = chat.prepare(
      'INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, service) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run(1, 'm-1', 'Budget draft attached', 1, 0, daysAgo(2), 'iMessage');
    insert.run(
      2,
      'm-2',
      'Will send numbers tomorrow',
      0,
      1,
      daysAgo(1),
      'iMessage',
    );
    insert.run(3, 'm-3', 'Running late', 2, 0, daysAgo(3), 'SMS');
    insert.run(4, 'm-4', 'Last year', 1, 0, daysAgo(400), 'iMessage');
    insert.run(5, 'm-5', 'See you at standup', 3, 0, daysAgo(4), 'iMessage');
    insert.run(6, 'm-6', 'Someone else', 4, 0, daysAgo(1), 'iMessage');
    insert.run(7, 'm-7', 'Sent as text message', 5, 0, daysAgo(5), 'SMS');
    chat
      .prepare(
        'INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, service) VALUES (8, ?, NULL, ?, 1, 0, ?, ?)',
      )
      .run(
        'm-8',
        archivedText('Only in the archived body'),
        daysAgo(6),
        'iMessage',
      );
    chat.exec(`
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2), (2, 3), (1, 4), (3, 5), (4, 6), (5, 7), (1, 8);
    `);
  }
  const database = await withHome(scratch.path, async () => {
    const { default: MessagesApp } =
      await import('@workspace/connector-apple-messages');
    return importApp(new MessagesApp(host), join(scratch.path, 'messages'));
  });

  const byPhone = read(database, query(reads.messages), {
    '@email': 'nobody@example.com',
    '@phone': '962791234567',
    '@days': 30,
  });
  const byEmail = read(database, query(reads.messages), {
    '@email': 'ANN@example.com',
    '@phone': '',
    '@days': 30,
  });

  assert.deepEqual(
    byPhone.map(({ text, isFromMe }) => [text, isFromMe]),
    [
      ['Will send numbers tomorrow', 1],
      ['Budget draft attached', 0],
      ['Running late', 0],
      ['Sent as text message', 0],
      ['Only in the archived body', 0],
    ],
  );
  assert.deepEqual(
    byEmail.map(({ text }) => text),
    ['See you at standup'],
  );
});

// Mail 16.0 on macOS 26.6.2: schema only, with no personal records or triggers.
const envelopeIndexSchema = `PRAGMA journal_mode = WAL;
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER NOT NULL DEFAULT 0,
global_message_id INTEGER NOT NULL,
remote_id INTEGER,
document_id TEXT COLLATE BINARY,
sender INTEGER,
subject_prefix TEXT COLLATE BINARY,
subject INTEGER NOT NULL,
summary INTEGER,
date_sent INTEGER,
date_received INTEGER,
mailbox INTEGER NOT NULL,
remote_mailbox INTEGER,
flags INTEGER NOT NULL DEFAULT 0,
read INTEGER NOT NULL DEFAULT 0,
flagged INTEGER NOT NULL DEFAULT 0,
deleted INTEGER NOT NULL DEFAULT 0,
size INTEGER NOT NULL DEFAULT 0,
conversation_id INTEGER NOT NULL DEFAULT 0,
date_last_viewed INTEGER,
list_id_hash INTEGER,
unsubscribe_type INTEGER,
searchable_message INTEGER,
brand_indicator INTEGER,
display_date INTEGER,
flag_color INTEGER,
color TEXT COLLATE BINARY,
type INTEGER,
fuzzy_ancestor INTEGER,
automated_conversation INTEGER DEFAULT 0,
root_status INTEGER DEFAULT -1, is_urgent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
total_count INTEGER NOT NULL DEFAULT 0,
unread_count INTEGER NOT NULL DEFAULT 0,
deleted_count INTEGER NOT NULL DEFAULT 0,
unseen_count INTEGER NOT NULL DEFAULT 0,
unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
change_identifier TEXT COLLATE BINARY,
source INTEGER,
alleged_change_identifier TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
comment TEXT COLLATE BINARY NOT NULL,
UNIQUE(address, comment) ON CONFLICT ABORT);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL,
address INTEGER NOT NULL,
type INTEGER,
position INTEGER,
UNIQUE(message, type, position) ON CONFLICT ABORT);
CREATE TABLE attachments (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
attachment_id TEXT COLLATE BINARY,
name TEXT COLLATE BINARY,
UNIQUE(message, attachment_id) ON CONFLICT ABORT);
CREATE TABLE labels (message_id INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE, mailbox_id INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;
CREATE TABLE server_messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
mailbox INTEGER NOT NULL REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
sequence_identifier INTEGER,
read INTEGER NOT NULL,
deleted INTEGER NOT NULL,
replied INTEGER NOT NULL,
flagged INTEGER NOT NULL,
draft INTEGER NOT NULL,
forwarded INTEGER NOT NULL,
redirected INTEGER NOT NULL,
junk_level_set_by_user INTEGER NOT NULL,
junk_level INTEGER NOT NULL,
flag_color INTEGER NOT NULL,
remote_id INTEGER NOT NULL,
UNIQUE(mailbox, remote_id) ON CONFLICT ABORT);
CREATE TABLE server_labels (server_message INTEGER REFERENCES server_messages(ROWID) ON DELETE CASCADE,
label INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
PRIMARY KEY(server_message, label)) WITHOUT ROWID;
CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
flags INTEGER NOT NULL DEFAULT 0,
sync_key TEXT COLLATE BINARY);
CREATE TABLE conversation_id_message_id (conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE ON UPDATE CASCADE,
message_id INTEGER NOT NULL DEFAULT 0,
date_sent INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY(conversation_id, message_id)) WITHOUT ROWID;
CREATE TABLE message_references (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
reference INTEGER NOT NULL DEFAULT 0,
is_originator INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER,
follow_up_start_date INTEGER,
follow_up_end_date INTEGER,
follow_up_jsonstringformodelevaluationforsuggestions TEXT COLLATE BINARY,
read_later_date INTEGER,
send_later_date INTEGER,
validation_state INTEGER NOT NULL DEFAULT 0,
model_category INTEGER,
model_subcategory INTEGER,
category_model_version INTEGER,
category_is_temporary INTEGER,
model_analytics TEXT COLLATE BINARY,
model_high_impact INTEGER NOT NULL DEFAULT 0,
generated_summary INTEGER,
urgent INTEGER, message_id_header TEXT COLLATE BINARY, due_by INTEGER,
UNIQUE(message_id) ON CONFLICT ABORT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
subject TEXT COLLATE RTRIM NOT NULL,
UNIQUE(subject) ON CONFLICT ABORT);
CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary TEXT COLLATE RTRIM NOT NULL,
UNIQUE(summary) ON CONFLICT ABORT);
CREATE TABLE generated_summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary BLOB NOT NULL,
status INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_metadata (message_id INTEGER PRIMARY KEY,
timestamp INTEGER NOT NULL,
json_values TEXT COLLATE BINARY NOT NULL);
CREATE TABLE data_detection_results (ROWID INTEGER PRIMARY KEY,
global_message_id INTEGER NOT NULL,
category TEXT COLLATE BINARY NOT NULL,
value TEXT COLLATE BINARY NOT NULL,
UNIQUE(global_message_id, category, value) ON CONFLICT ABORT);
CREATE TABLE rich_links (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT COLLATE BINARY,
url TEXT COLLATE BINARY NOT NULL,
hash TEXT COLLATE BINARY NOT NULL,
UNIQUE(hash) ON CONFLICT ABORT);
CREATE TABLE message_rich_links (global_message_id INTEGER NOT NULL REFERENCES message_global_data(ROWID) ON DELETE CASCADE,
rich_link INTEGER NOT NULL REFERENCES rich_links(ROWID) ON DELETE CASCADE,
PRIMARY KEY(global_message_id, rich_link)) WITHOUT ROWID;
CREATE TABLE protected_message_data (ROWID INTEGER PRIMARY KEY,
data TEXT COLLATE BINARY);
CREATE TABLE brand_indicators (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
indicator BLOB,
indicator_hash TEXT COLLATE BINARY,
hash_algorithm TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE brand_indicator_evidence (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
brand_indicator INTEGER NOT NULL REFERENCES brand_indicators(ROWID) ON DELETE CASCADE ON UPDATE CASCADE,
url TEXT COLLATE BINARY NOT NULL,
evidence BLOB,
unverified_messages TEXT COLLATE BINARY,
UNIQUE(brand_indicator, url) ON CONFLICT ABORT);
CREATE TABLE address_metadata (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
smime_capabilities TEXT COLLATE NOCASE NOT NULL,
smime_capabilities_date INTEGER NOT NULL,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE businesses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address_comment TEXT COLLATE NOCASE,
domain TEXT COLLATE NOCASE,
brand_id INTEGER,
localized_brand_name TEXT,
UNIQUE(address_comment, domain) ON CONFLICT ABORT,
UNIQUE(brand_id) ON CONFLICT ABORT,
CHECK(((address_comment IS NOT NULL AND domain IS NOT NULL AND brand_id IS NULL AND localized_brand_name IS NULL) OR (address_comment IS NULL AND domain IS NULL AND brand_id IS NOT NULL AND localized_brand_name IS NOT NULL))));
CREATE TABLE business_addresses (ROWID INTEGER PRIMARY KEY,
address INTEGER NOT NULL,
business INTEGER NOT NULL,
category INTEGER,
last_modified INTEGER,
last_bcs_sync INTEGER,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE business_categories (ROWID INTEGER PRIMARY KEY,
business INTEGER NOT NULL,
category INTEGER NOT NULL,
UNIQUE(business) ON CONFLICT ABORT);
CREATE TABLE senders (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
contact_identifier TEXT COLLATE BINARY,
bucket INTEGER NOT NULL DEFAULT 0,
user_initiated INTEGER NOT NULL DEFAULT 1,
UNIQUE(contact_identifier) ON CONFLICT ABORT);
CREATE TABLE sender_addresses (address INTEGER PRIMARY KEY,
sender INTEGER NOT NULL REFERENCES senders(ROWID) ON DELETE CASCADE);
CREATE TABLE events (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE, start_date INTEGER, end_date INTEGER, location TEXT, out_of_date INTEGER DEFAULT 0, processed INTEGER DEFAULT 0, is_all_day INTEGER DEFAULT 0, associated_id_string TEXT, original_receiving_account TEXT, ical_uid TEXT, is_response_requested INTEGER DEFAULT 0);`;

const plist = (value: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${value}</plist>`;

// A message file as Mail keeps one: the MIME's byte length, the MIME, then
// Mail's own property list.
const emlx = (headers: Record<string, string>, body: string) => {
  const mime = [
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
    '',
  ].join('\r\n');
  return `${Buffer.byteLength(mime)}      \n${mime}${plist('<dict><key>flags</key><integer>1</integer></dict>')}`;
};

test('meeting prep finds recent mail with an attendee whatever case Mail stored, and mail about a meeting by subject', async (t) => {
  // Mail's account metadata comes from scripting Mail; only that request is
  // answered.
  t.mock.method(osa, 'execute', async (script: string) => {
    assert.match(script, /\/\/ apple-mail:account-metadata/);
    return JSON.stringify({
      accounts: [
        {
          id: 'ACCOUNT',
          name: 'Work',
          type: 'imap',
          enabled: true,
          emailAddresses: ['me@example.com'],
          fullName: 'Me',
          userName: 'me@example.com',
          serverName: 'imap.example.com',
          port: 993,
          usesSsl: true,
          directory: '/Users/tester/Library/Mail/V10/ACCOUNT',
        },
      ],
      smtpServers: [],
    });
  });
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'meeting-prep-mail-'),
  );
  const root = join(scratch.path, 'Library/Mail');
  const mailbox = join(root, 'V10/ACCOUNT/Inbox.mbox');
  mkdirSync(join(mailbox, 'UUID/Data/Messages'), { recursive: true });
  mkdirSync(join(root, 'V10/MailData'), { recursive: true });
  writeFileSync(
    join(root, 'PersistenceInfo.plist'),
    plist(
      '<dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict>',
    ),
  );
  writeFileSync(
    join(mailbox, 'Info.plist'),
    plist('<dict><key>MailboxID</key><string>INBOX</string></dict>'),
  );
  const now = Math.floor(Date.now() / 1000);
  const daysAgo = (days: number) => now - days * 24 * 60 * 60;
  const messages = [
    {
      id: 1,
      from: 'Ann <Ann@Example.com>',
      to: 'me@example.com',
      subject: 'Budget numbers',
      body: 'Here are the Q3 numbers.',
      received: daysAgo(2),
    },
    {
      id: 2,
      from: 'Me <me@example.com>',
      to: 'ann@example.com',
      subject: 'Re: Budget numbers',
      body: 'Thanks, reviewing before standup.',
      received: daysAgo(1),
    },
    {
      id: 3,
      from: 'Ann <ann@example.com>',
      to: 'me@example.com',
      subject: 'Old thread',
      body: 'From last year.',
      received: daysAgo(400),
    },
    {
      id: 4,
      from: 'Bo <bo@example.com>',
      to: 'me@example.com',
      subject: 'Standup notes',
      body: 'Agenda for standup.',
      received: daysAgo(3),
    },
  ];
  for (const message of messages)
    writeFileSync(
      join(mailbox, 'UUID/Data/Messages', `${message.id}.emlx`),
      emlx(
        {
          From: message.from,
          To: message.to,
          Subject: message.subject,
          'Message-ID': `<m${message.id}@example.com>`,
        },
        message.body,
      ),
    );
  {
    using index = new DatabaseSync(join(root, 'V10/MailData/Envelope Index'));
    index.exec(envelopeIndexSchema);
    index.exec(`
      INSERT INTO mailboxes(ROWID, url) VALUES (1, 'imap://ACCOUNT/INBOX');
      INSERT INTO addresses VALUES
        (1, 'Ann@Example.com', 'Ann'),
        (2, 'ann@example.com', 'Ann Lee'),
        (3, 'me@example.com', 'Me'),
        (4, 'bo@example.com', 'Bo');
      INSERT INTO subjects VALUES (1, 'Budget numbers'), (2, 'Old thread'), (3, 'Standup notes');
      INSERT INTO message_global_data(ROWID, message_id, message_id_header) VALUES
        (1, 1, '<m1@example.com>'), (2, 2, '<m2@example.com>'), (3, 3, '<m3@example.com>'), (4, 4, '<m4@example.com>');
      INSERT INTO messages(ROWID, message_id, global_message_id, subject, subject_prefix, mailbox, sender, date_sent, date_received) VALUES
        (1, 1, 1, 1, NULL, 1, 1, ${daysAgo(2)}, ${daysAgo(2)}),
        (2, 2, 2, 1, 'Re: ', 1, 3, ${daysAgo(1)}, ${daysAgo(1)}),
        (3, 3, 3, 2, NULL, 1, 2, ${daysAgo(400)}, ${daysAgo(400)}),
        (4, 4, 4, 3, NULL, 1, 4, ${daysAgo(3)}, ${daysAgo(3)});
      INSERT INTO recipients VALUES
        (1, 1, 3, 0, 0), (2, 2, 2, 0, 0), (3, 3, 3, 0, 0), (4, 4, 3, 0, 0);
    `);
  }
  const database = await withHome(scratch.path, async () => {
    const { default: MailApp } =
      await import('@workspace/connector-apple-mail');
    return importApp(new MailApp(host), join(scratch.path, 'mail'));
  });

  const withAnn = read(database, query(reads.mail), {
    '@email': 'ann@example.com',
    '@days': 30,
  });
  const aboutStandup = read(database, query(reads.mailSubjects), {
    '@term': 'Standup',
    '@days': 30,
  });

  assert.deepEqual(
    withAnn.map(({ subject, sender, excerpt }) => [subject, sender, excerpt]),
    [
      [
        'Budget numbers',
        'me@example.com',
        'Thanks, reviewing before standup.\r\n',
      ],
      ['Budget numbers', 'Ann@Example.com', 'Here are the Q3 numbers.\r\n'],
    ],
  );
  assert.deepEqual(
    aboutStandup.map(({ subject, sender }) => [subject, sender]),
    [['Standup notes', 'bo@example.com']],
  );
});
