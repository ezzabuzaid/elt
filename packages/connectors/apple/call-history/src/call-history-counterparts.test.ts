import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
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

// The SDK finds the call history store under HOME when its module loads, so
// the connector is imported only after HOME points at the test's folder.
// node --test runs this file in its own process.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: CallHistoryConnector } =
      await import('./call-history-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Call History reads nothing through EventKit.
    return new CallHistoryConnector(
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

// CallHistory.storedata's tables as macOS 27's callhistoryd creates them
// (CallHistory model 46), schema only, in WAL mode like the real store.
const callHistorySchema = `PRAGMA journal_mode = WAL;
CREATE TABLE ZCALLDBPROPERTIES ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTIMER_ALL FLOAT, ZTIMER_INCOMING FLOAT, ZTIMER_LAST FLOAT, ZTIMER_LIFETIME FLOAT, ZTIMER_OUTGOING FLOAT );
CREATE TABLE ZCALLRECORD ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZAUTOANSWEREDREASON INTEGER, ZCALLDIRECTORYIDENTITYTYPE INTEGER, ZCALL_CATEGORY INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER, ZFACE_TIME_DATA INTEGER, ZFILTERED_OUT_REASON INTEGER, ZHANDLE_TYPE INTEGER, ZHASMESSAGE INTEGER, ZJUNKCONFIDENCE INTEGER, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER, ZREAD INTEGER, ZSCREENSHARINGTYPE INTEGER, ZUSEDEMERGENCYVIDEOSTREAMING INTEGER, ZVERIFICATIONSTATUS INTEGER, ZWASEMERGENCYCALL INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR, ZBLOCKEDBYEXTENSION VARCHAR, ZIDENTITYEXTENSION VARCHAR, ZISO_COUNTRY_CODE VARCHAR, ZJUNKIDENTIFICATIONCATEGORY VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR, ZCONVERSATIONID BLOB, ZIMAGEURL VARCHAR, ZLOCALPARTICIPANTUUID BLOB, ZOUTGOINGLOCALPARTICIPANTUUID BLOB, ZPARTICIPANTGROUPUUID BLOB , ZINITIATOR INTEGER, ZBLOCKEDBYEXTENSIONNAME VARCHAR, ZREMINDERUUID BLOB, ZNEEDEDSCANNOUNCEMENT INTEGER, ZCOMMUNICATIONTRUSTSCORE INTEGER, ZORIGINATINGUITYPE INTEGER, ZORIGINATINGDEVICENAME VARCHAR, ZDIDENABLETRANSLATION INTEGER, ZSAINT_DAVIDS_1 INTEGER, ZSAINT_DAVIDS_2 VARCHAR);
CREATE TABLE ZEMERGENCYMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZEMERGENCYMEDIATYPE INTEGER, ZUPLOADEDFORCALL INTEGER, ZASSETID VARCHAR );
CREATE TABLE ZHANDLE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER, ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR );
CREATE TABLE ZSAINTDAVIDSCOUNTS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCOUNT INTEGER, ZTYPE INTEGER, ZCALL INTEGER );
CREATE TABLE Z_2REMOTEPARTICIPANTHANDLES ( Z_2REMOTEPARTICIPANTCALLS INTEGER, Z_4REMOTEPARTICIPANTHANDLES INTEGER, PRIMARY KEY (Z_2REMOTEPARTICIPANTCALLS, Z_4REMOTEPARTICIPANTHANDLES) );
CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
CREATE TABLE Z_MODELCACHE (Z_CONTENT BLOB);
CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
INSERT INTO Z_PRIMARYKEY VALUES (1, 'CallDBProperties', 0, 0), (2, 'CallRecord', 0, 0), (3, 'EmergencyMediaItem', 0, 0), (4, 'Handle', 0, 0), (5, 'SaintDavidsCounts', 0, 0);`;

// Z_PRIMARYKEY's entities.
const callEntity = 2;
const handleEntity = 4;
// ZHANDLE.ZTYPE as callhistoryd writes it.
const phoneHandle = 2;
const emailHandle = 3;
// ZCALLRECORD.ZCALLTYPE.
const phone = 1;
const faceTimeVideo = 8;
const faceTimeAudio = 16;

// Core Data stores dates as seconds since 2001-01-01.
const coreData = (iso: string) => Date.parse(iso) / 1000 - 978307200;

// The call history store where callhistoryd keeps it under HOME: its handles,
// its calls, and the handles each call names as remote participants.
function storeUnder(
  home: string,
  store: {
    handles: readonly Record<string, SQLInputValue>[];
    calls: readonly Record<string, SQLInputValue>[];
    participants: readonly (readonly [call: number, handle: number])[];
  },
): void {
  const directory = join(home, 'Library/Application Support/CallHistoryDB');
  mkdirSync(directory, { recursive: true });
  using database = new DatabaseSync(join(directory, 'CallHistory.storedata'));
  database.exec(callHistorySchema);
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const columns = Object.keys(row);
    database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...Object.values(row));
  };
  for (const row of store.handles)
    insert('ZHANDLE', { Z_ENT: handleEntity, ...row });
  for (const row of store.calls)
    insert('ZCALLRECORD', { Z_ENT: callEntity, ...row });
  for (const [call, participant] of store.participants)
    insert('Z_2REMOTEPARTICIPANTHANDLES', {
      Z_2REMOTEPARTICIPANTCALLS: call,
      Z_4REMOTEPARTICIPANTHANDLES: participant,
    });
}

test('Call History counterparts give each party of a call the direction and answer of its calls, an email or an E.164 phone or an app number, and the number the user called from as self', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'call-history-counterparts-'),
  );
  storeUnder(home.path, {
    handles: [
      {
        Z_PK: 1,
        ZTYPE: phoneHandle,
        ZVALUE: '+962 79 123 4567',
        ZNORMALIZEDVALUE: '+962791234567',
      },
      // callhistoryd leaves some handles without a normalized value.
      { Z_PK: 2, ZTYPE: phoneHandle, ZVALUE: '+962 79 123 4567' },
      { Z_PK: 3, ZTYPE: phoneHandle, ZVALUE: '+962 79 000 0001' },
      {
        Z_PK: 4,
        ZTYPE: phoneHandle,
        ZVALUE: '+962 79 123 4567',
        ZNORMALIZEDVALUE: '+962791234567',
      },
      {
        Z_PK: 5,
        ZTYPE: phoneHandle,
        ZVALUE: '962781112222',
        ZNORMALIZEDVALUE: '962781112222',
      },
      { Z_PK: 6, ZTYPE: phoneHandle, ZVALUE: '079 555 1234' },
      {
        Z_PK: 7,
        ZTYPE: phoneHandle,
        // Dialed with the tones that follow it, as a phone menu asks.
        ZVALUE: '98877,,1',
        ZNORMALIZEDVALUE: '98877',
      },
      {
        Z_PK: 8,
        ZTYPE: emailHandle,
        ZVALUE: 'Ada@Example.com',
        ZNORMALIZEDVALUE: 'ada@example.com',
      },
      { Z_PK: 9, ZTYPE: emailHandle, ZVALUE: 'Ada@Example.com' },
      {
        Z_PK: 10,
        ZTYPE: phoneHandle,
        ZVALUE: '+44 20 7946 0000',
        ZNORMALIZEDVALUE: '+442079460000',
      },
    ],
    calls: [
      {
        Z_PK: 1,
        ZUNIQUE_ID: 'CALL-OUT-PHONE',
        ZDATE: coreData('2026-09-01T10:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 1,
        ZANSWERED: 0,
        ZDURATION: 120.6,
        ZNAME: 'Rana',
        ZADDRESS: '+962 79 123 4567',
      },
      // The user placed this call from their own number.
      {
        Z_PK: 2,
        ZUNIQUE_ID: 'CALL-OUT-FACETIME',
        ZDATE: coreData('2026-09-03T10:00:00Z'),
        ZCALLTYPE: faceTimeAudio,
        ZORIGINATED: 1,
        ZANSWERED: 0,
        ZDURATION: 60,
        ZNAME: 'Rana Haddad',
        ZADDRESS: '+962 79 123 4567',
        ZINITIATOR: 3,
      },
      {
        Z_PK: 3,
        ZUNIQUE_ID: 'CALL-OUT-UNNAMED',
        ZDATE: coreData('2026-09-04T10:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 1,
        ZANSWERED: 0,
        ZADDRESS: '+962 79 123 4567',
      },
      {
        Z_PK: 4,
        ZUNIQUE_ID: 'CALL-ANSWERED',
        ZDATE: coreData('2026-09-05T09:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 0,
        ZANSWERED: 1,
        ZDURATION: 30,
        ZNAME: 'Omar',
        ZADDRESS: '962781112222',
      },
      {
        Z_PK: 5,
        ZUNIQUE_ID: 'CALL-MISSED',
        ZDATE: coreData('2026-09-06T09:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 0,
        ZANSWERED: 0,
        ZDURATION: 0,
        ZADDRESS: '079 555 1234',
      },
      {
        Z_PK: 6,
        ZUNIQUE_ID: 'CALL-SHORT-CODE',
        ZDATE: coreData('2026-09-07T09:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 0,
        ZANSWERED: 1,
        ZDURATION: 15,
        ZADDRESS: '98877,,1',
      },
      // Ada started a group FaceTime call with the user and a third party.
      {
        Z_PK: 7,
        ZUNIQUE_ID: 'CALL-GROUP',
        ZDATE: coreData('2026-09-08T18:30:00Z'),
        ZCALLTYPE: faceTimeVideo,
        ZORIGINATED: 0,
        ZANSWERED: 1,
        ZDURATION: 600,
        ZINITIATOR: 8,
      },
      // A call whose participant callhistoryd did not record.
      {
        Z_PK: 8,
        ZUNIQUE_ID: 'CALL-ADDRESS-ONLY',
        ZDATE: coreData('2026-09-09T12:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 1,
        ZANSWERED: 0,
        ZDURATION: 45,
        ZADDRESS: '+1 (555) 010-0100',
      },
      // A withheld number names no other party, so the call has no row.
      {
        Z_PK: 9,
        ZUNIQUE_ID: 'CALL-WITHHELD',
        ZDATE: coreData('2026-09-10T08:00:00Z'),
        ZCALLTYPE: phone,
        ZORIGINATED: 0,
        ZANSWERED: 0,
        ZDURATION: 0,
        ZNUMBER_AVAILABILITY: 1,
      },
      // A call type this reader does not know, with no direction or answer.
      {
        Z_PK: 10,
        ZUNIQUE_ID: 'CALL-NEW-KIND',
        ZDATE: coreData('2026-09-12T12:00:00Z'),
        ZCALLTYPE: 64,
        ZADDRESS: '+962780000009',
      },
    ],
    participants: [
      [1, 1],
      [2, 2],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 9],
      [7, 10],
    ],
  });
  const connector = await connectorUnder(home.path);

  const database = await importAll(connector, join(home.path, 'Apple'));

  const row = (
    relation: string,
    identifier_type: string,
    identifier: string,
    name: string | null,
    first_at: string,
    last_at: string,
    occurrences: number,
    context: string,
  ) => ({
    relation,
    identifier_type,
    identifier,
    linked_type: null,
    linked_identifier: null,
    name,
    first_at,
    last_at,
    occurrences,
    context,
  });
  assert.deepEqual(
    read(
      database,
      'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM counterparts ORDER BY relation, identifier',
    ),
    [
      // Each other party of a group call is a counterpart of that call; the
      // one who started it is not the user.
      row(
        'answered-call',
        'phone',
        '+442079460000',
        null,
        '2026-09-08T18:30:00.000000Z',
        '2026-09-08T18:30:00.000000Z',
        1,
        '{"kinds":{"faceTimeVideo":1},"seconds":600}',
      ),
      // International digits without + are an E.164 number.
      row(
        'answered-call',
        'phone',
        '+962781112222',
        'Omar',
        '2026-09-05T09:00:00.000000Z',
        '2026-09-05T09:00:00.000000Z',
        1,
        '{"kinds":{"phone":1},"seconds":30}',
      ),
      // A short code has no E.164 form; its digits, without the tones dialed
      // after them, match an SMS sender.
      row(
        'answered-call',
        'app',
        '98877',
        null,
        '2026-09-07T09:00:00.000000Z',
        '2026-09-07T09:00:00.000000Z',
        1,
        '{"kinds":{"phone":1},"seconds":15}',
      ),
      row(
        'answered-call',
        'email',
        'ada@example.com',
        null,
        '2026-09-08T18:30:00.000000Z',
        '2026-09-08T18:30:00.000000Z',
        1,
        '{"kinds":{"faceTimeVideo":1},"seconds":600}',
      ),
      // A call that stores no direction or answer counts as missed.
      row(
        'missed-call',
        'phone',
        '+962780000009',
        null,
        '2026-09-12T12:00:00.000000Z',
        '2026-09-12T12:00:00.000000Z',
        1,
        '{"kinds":{"other":1},"seconds":0}',
      ),
      // A number in national form needs a country to reach E.164; its
      // digits match the same number written another way.
      row(
        'missed-call',
        'app',
        '0795551234',
        null,
        '2026-09-06T09:00:00.000000Z',
        '2026-09-06T09:00:00.000000Z',
        1,
        '{"kinds":{"phone":1},"seconds":0}',
      ),
      // With no participant, the call's address names the other party.
      row(
        'outgoing-call',
        'phone',
        '+15550100100',
        null,
        '2026-09-09T12:00:00.000000Z',
        '2026-09-09T12:00:00.000000Z',
        1,
        '{"kinds":{"phone":1},"seconds":45}',
      ),
      // Three calls to one number, the latest that showed a name naming it.
      row(
        'outgoing-call',
        'phone',
        '+962791234567',
        'Rana Haddad',
        '2026-09-01T10:00:00.000000Z',
        '2026-09-04T10:00:00.000000Z',
        3,
        '{"kinds":{"faceTimeAudio":1,"phone":2},"seconds":181}',
      ),
      row(
        'self',
        'phone',
        '+962790000001',
        null,
        '2026-09-03T10:00:00.000000Z',
        '2026-09-03T10:00:00.000000Z',
        1,
        '{"kinds":{"faceTimeAudio":1},"seconds":60}',
      ),
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
