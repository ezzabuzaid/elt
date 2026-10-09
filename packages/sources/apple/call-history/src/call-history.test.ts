import assert from 'node:assert/strict';
import { chmod, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';

import {
  Connection,
  Copy,
  type CopyResult,
  Pipeline,
  PipelineError,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import {
  CallHistorySchemaError,
  CallHistoryUnavailableError,
  callHistoryStorePath,
} from '@workspace/sdk-apple-call-history';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { AppleCallHistorySource } from './apple-call-history-source.ts';

// A synthetic CallHistory.storedata with every table macOS 27's callhistoryd
// creates (CallHistory model 46), as its schema declares them, in WAL mode as
// callhistoryd keeps it.
class ScratchCallHistory implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE ZCALLDBPROPERTIES ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTIMER_ALL FLOAT, ZTIMER_INCOMING FLOAT, ZTIMER_LAST FLOAT, ZTIMER_LIFETIME FLOAT, ZTIMER_OUTGOING FLOAT );
      CREATE TABLE ZCALLRECORD ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZAUTOANSWEREDREASON INTEGER, ZCALLDIRECTORYIDENTITYTYPE INTEGER, ZCALL_CATEGORY INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER, ZFACE_TIME_DATA INTEGER, ZFILTERED_OUT_REASON INTEGER, ZHANDLE_TYPE INTEGER, ZHASMESSAGE INTEGER, ZJUNKCONFIDENCE INTEGER, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER, ZREAD INTEGER, ZSCREENSHARINGTYPE INTEGER, ZUSEDEMERGENCYVIDEOSTREAMING INTEGER, ZVERIFICATIONSTATUS INTEGER, ZWASEMERGENCYCALL INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR, ZBLOCKEDBYEXTENSION VARCHAR, ZIDENTITYEXTENSION VARCHAR, ZISO_COUNTRY_CODE VARCHAR, ZJUNKIDENTIFICATIONCATEGORY VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR, ZCONVERSATIONID BLOB, ZIMAGEURL VARCHAR, ZLOCALPARTICIPANTUUID BLOB, ZOUTGOINGLOCALPARTICIPANTUUID BLOB, ZPARTICIPANTGROUPUUID BLOB , ZINITIATOR INTEGER, ZBLOCKEDBYEXTENSIONNAME VARCHAR, ZREMINDERUUID BLOB, ZNEEDEDSCANNOUNCEMENT INTEGER, ZCOMMUNICATIONTRUSTSCORE INTEGER, ZORIGINATINGUITYPE INTEGER, ZORIGINATINGDEVICENAME VARCHAR, ZDIDENABLETRANSLATION INTEGER, ZSAINT_DAVIDS_1 INTEGER, ZSAINT_DAVIDS_2 VARCHAR);
      CREATE TABLE ZEMERGENCYMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZEMERGENCYMEDIATYPE INTEGER, ZUPLOADEDFORCALL INTEGER, ZASSETID VARCHAR );
      CREATE TABLE ZHANDLE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER, ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR );
      CREATE TABLE ZSAINTDAVIDSCOUNTS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCOUNT INTEGER, ZTYPE INTEGER, ZCALL INTEGER );
      CREATE TABLE Z_2REMOTEPARTICIPANTHANDLES ( Z_2REMOTEPARTICIPANTCALLS INTEGER, Z_4REMOTEPARTICIPANTHANDLES INTEGER, PRIMARY KEY (Z_2REMOTEPARTICIPANTCALLS, Z_4REMOTEPARTICIPANTHANDLES) );
      CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
      CREATE TABLE Z_MODELCACHE (Z_CONTENT BLOB);
      CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
      INSERT INTO Z_PRIMARYKEY VALUES (1, 'CallDBProperties', 0, 0), (2, 'CallRecord', 0, 0), (3, 'EmergencyMediaItem', 0, 0), (4, 'Handle', 0, 0), (5, 'SaintDavidsCounts', 0, 0);
    `);
  }

  insert(table: string, row: Record<string, SQLInputValue>): void {
    const columns = Object.keys(row);
    this.#database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...Object.values(row));
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

// Core Data stores dates as seconds since 2001-01-01.
const coreData = (iso: string) => Date.parse(iso) / 1000 - 978307200;
const uuidBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

// Five calls: an answered outgoing phone call with a distinct value in every
// column, an incoming group FaceTime video call with media shared during it, a
// missed call from a withheld number, a call of a type this reader does not
// know, and an outgoing FaceTime audio call; plus a media item and a count that
// name no call.
function callHistoryFixture(path: string): void {
  using store = new ScratchCallHistory(path);
  store.insert('ZHANDLE', {
    Z_PK: 1,
    Z_ENT: 4,
    ZTYPE: 2,
    ZVALUE: '+1 (555) 010-0100',
    ZNORMALIZEDVALUE: '+15550100100',
  });
  store.insert('ZCALLRECORD', {
    Z_PK: 1,
    Z_ENT: 2,
    ZUNIQUE_ID: 'CALL-PHONE',
    // A Core Data date carries microseconds.
    ZDATE: coreData('2026-09-01T10:00:00.250Z') + 0.000123,
    ZDURATION: 125.5,
    ZSERVICE_PROVIDER: 'com.apple.Telephony',
    ZCALLTYPE: 1,
    ZCALL_CATEGORY: 1,
    ZORIGINATED: 1,
    ZANSWERED: 1,
    ZREAD: 1,
    ZHASMESSAGE: 0,
    ZADDRESS: '+1 (555) 010-0100',
    ZNAME: 'Grace Hopper',
    ZLOCATION: 'Arlington, VA',
    ZISO_COUNTRY_CODE: 'us',
    ZHANDLE_TYPE: 2,
    ZNUMBER_AVAILABILITY: 4,
    ZDISCONNECTED_CAUSE: 1,
    ZFILTERED_OUT_REASON: 6,
    ZBLOCKEDBYEXTENSION: 'com.example.blocker',
    ZBLOCKEDBYEXTENSIONNAME: 'Example Blocker',
    ZIDENTITYEXTENSION: 'com.example.callerid',
    ZCALLDIRECTORYIDENTITYTYPE: 3,
    ZJUNKCONFIDENCE: 7,
    ZJUNKIDENTIFICATIONCATEGORY: 'Sales',
    ZVERIFICATIONSTATUS: 8,
    ZCOMMUNICATIONTRUSTSCORE: 5,
    ZAUTOANSWEREDREASON: 2,
    ZSCREENSHARINGTYPE: 9,
    ZORIGINATINGUITYPE: 45,
    ZORIGINATINGDEVICENAME: 'Test iPhone',
    ZFACE_TIME_DATA: 5489619075,
    ZWASEMERGENCYCALL: 0,
    ZUSEDEMERGENCYVIDEOSTREAMING: 1,
    ZDIDENABLETRANSLATION: 1,
    ZNEEDEDSCANNOUNCEMENT: 0,
    ZCONVERSATIONID: uuidBytes('aaaaaaaa000000000000000000000001'),
    ZLOCALPARTICIPANTUUID: uuidBytes('bbbbbbbb000000000000000000000002'),
    ZOUTGOINGLOCALPARTICIPANTUUID: uuidBytes(
      'cccccccc000000000000000000000003',
    ),
    ZPARTICIPANTGROUPUUID: uuidBytes('dddddddd000000000000000000000004'),
    ZREMINDERUUID: uuidBytes('eeeeeeee000000000000000000000005'),
    ZIMAGEURL: 'https://example.com/grace.png',
    ZSAINT_DAVIDS_1: 11,
    ZSAINT_DAVIDS_2: 'twelve',
  });
  store.insert('Z_2REMOTEPARTICIPANTHANDLES', {
    Z_2REMOTEPARTICIPANTCALLS: 1,
    Z_4REMOTEPARTICIPANTHANDLES: 1,
  });
  // The initiator and each remote participant get their own handle rows.
  for (const [pk, value] of [
    [2, 'ada@example.com'],
    [3, 'ada@example.com'],
    [4, 'alan@example.com'],
    [5, 'grace@example.com'],
  ] as const)
    store.insert('ZHANDLE', {
      Z_PK: pk,
      Z_ENT: 4,
      ZTYPE: 3,
      ZVALUE: value,
      ZNORMALIZEDVALUE: value,
    });
  store.insert('ZCALLRECORD', {
    Z_PK: 2,
    Z_ENT: 2,
    ZUNIQUE_ID: 'CALL-GROUP',
    ZDATE: coreData('2026-09-05T18:30:00.000Z'),
    ZDURATION: 600,
    ZSERVICE_PROVIDER: 'com.apple.FaceTime',
    ZCALLTYPE: 8,
    ZCALL_CATEGORY: 2,
    ZORIGINATED: 0,
    ZANSWERED: 1,
    ZREAD: 1,
    ZHANDLE_TYPE: 3,
    ZINITIATOR: 2,
    ZCONVERSATIONID: uuidBytes('0123456789abcdef0123456789abcdef'),
    ZPARTICIPANTGROUPUUID: uuidBytes('fedcba9876543210fedcba9876543210'),
  });
  for (const handle of [3, 4, 5])
    store.insert('Z_2REMOTEPARTICIPANTHANDLES', {
      Z_2REMOTEPARTICIPANTCALLS: 2,
      Z_4REMOTEPARTICIPANTHANDLES: handle,
    });
  store.insert('ZEMERGENCYMEDIAITEM', {
    Z_PK: 1,
    Z_ENT: 3,
    ZEMERGENCYMEDIATYPE: 1,
    ZUPLOADEDFORCALL: 2,
    ZASSETID: 'ASSET-1',
  });
  store.insert('ZEMERGENCYMEDIAITEM', {
    Z_PK: 2,
    Z_ENT: 3,
    ZEMERGENCYMEDIATYPE: 2,
    ZASSETID: 'ASSET-2',
  });
  store.insert('ZCALLRECORD', {
    Z_PK: 3,
    Z_ENT: 2,
    ZUNIQUE_ID: 'CALL-WITHHELD',
    ZDATE: coreData('2026-09-10T08:00:00.000Z'),
    ZDURATION: 0,
    ZSERVICE_PROVIDER: 'com.apple.Telephony',
    ZCALLTYPE: 1,
    ZCALL_CATEGORY: 1,
    ZORIGINATED: 0,
    ZANSWERED: 0,
    ZREAD: 0,
    ZNUMBER_AVAILABILITY: 1,
  });
  store.insert('ZCALLRECORD', {
    Z_PK: 4,
    Z_ENT: 2,
    ZUNIQUE_ID: 'CALL-NEW-KIND',
    ZDATE: coreData('2026-09-12T12:00:00.000Z'),
    ZCALLTYPE: 64,
    ZCALL_CATEGORY: 3,
  });
  store.insert('ZCALLRECORD', {
    Z_PK: 6,
    Z_ENT: 2,
    ZUNIQUE_ID: 'CALL-FACETIME-AUDIO',
    ZDATE: coreData('2026-09-15T20:00:00.000Z'),
    ZDURATION: 30,
    ZSERVICE_PROVIDER: 'com.apple.FaceTime',
    ZCALLTYPE: 16,
    ZCALL_CATEGORY: 1,
    ZORIGINATED: 1,
    ZANSWERED: 1,
    ZREAD: 1,
  });
  store.insert('ZSAINTDAVIDSCOUNTS', {
    Z_PK: 1,
    Z_ENT: 5,
    ZCALL: 1,
    ZTYPE: 4,
    ZCOUNT: 2,
  });
  store.insert('ZSAINTDAVIDSCOUNTS', {
    Z_PK: 2,
    Z_ENT: 5,
    ZTYPE: 7,
    ZCOUNT: 1,
  });
  store.insert('ZCALLDBPROPERTIES', {
    Z_PK: 1,
    Z_ENT: 1,
    ZTIMER_ALL: 0,
    ZTIMER_INCOMING: 3600,
    ZTIMER_OUTGOING: 7200,
    ZTIMER_LAST: 125.5,
    ZTIMER_LIFETIME: 10800,
  });
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

async function pipeline(source: AppleCallHistorySource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const { streams } = await source.discover();
  return new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

const unchanged = {
  calls: { count: 0, deleted: 0 },
  callParticipants: { count: 0, deleted: 0 },
  callTimers: { count: 0, deleted: 0 },
  emergencyMediaItems: { count: 0, deleted: 0 },
  saintDavidsCounts: { count: 0, deleted: 0 },
};

// Each kind of failure a run's copies reported, once.
function failureTypes(error: {
  readonly results: readonly {
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

test('every Call History stream loads the store decoded, and a second run writes nothing', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  const source = new AppleCallHistorySource(path);
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');

  await run.run();
  const second = await run.run();

  const columns = Object.keys(source.calls.jsonSchema.properties ?? {})
    .map((column) => `"${column}"`)
    .join(', ');
  assert.deepEqual(
    rows(out, `SELECT ${columns} FROM calls WHERE id = 'CALL-PHONE'`),
    [
      {
        id: 'CALL-PHONE',
        startedAt: '2026-09-01T10:00:00.250123Z',
        duration: 125.5,
        serviceProvider: 'com.apple.Telephony',
        kind: 'phone',
        kindCode: 1,
        category: 'audio',
        categoryCode: 1,
        outgoing: 1,
        answered: 1,
        read: 1,
        hasMessage: 0,
        address: '+1 (555) 010-0100',
        name: 'Grace Hopper',
        location: 'Arlington, VA',
        isoCountryCode: 'us',
        handleType: 2,
        initiatorType: null,
        initiatorValue: null,
        initiatorNormalizedValue: null,
        numberAvailability: 4,
        disconnectedCause: 1,
        filteredOutReason: 6,
        blockedByExtension: 'com.example.blocker',
        blockedByExtensionName: 'Example Blocker',
        identityExtension: 'com.example.callerid',
        callDirectoryIdentityType: 3,
        junkConfidence: 7,
        junkIdentificationCategory: 'Sales',
        verificationStatus: 8,
        communicationTrustScore: 5,
        autoAnsweredReason: 2,
        screenSharingType: 9,
        originatingUIType: 45,
        originatingDeviceName: 'Test iPhone',
        faceTimeData: 5489619075,
        wasEmergencyCall: 0,
        usedEmergencyVideoStreaming: 1,
        didEnableTranslation: 1,
        neededSCAnnouncement: 0,
        conversationId: 'AAAAAAAA-0000-0000-0000-000000000001',
        localParticipantUuid: 'BBBBBBBB-0000-0000-0000-000000000002',
        outgoingLocalParticipantUuid: 'CCCCCCCC-0000-0000-0000-000000000003',
        participantGroupUuid: 'DDDDDDDD-0000-0000-0000-000000000004',
        reminderUuid: 'EEEEEEEE-0000-0000-0000-000000000005',
        imageUrl: 'https://example.com/grace.png',
        saintDavids1: 11,
        saintDavids2: 'twelve',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT id, startedAt, duration, serviceProvider, kind, kindCode, category,
              categoryCode, outgoing, answered, read, hasMessage, address, name,
              location, isoCountryCode, handleType, initiatorType, initiatorValue,
              initiatorNormalizedValue, numberAvailability, disconnectedCause,
              originatingDeviceName, conversationId, participantGroupUuid
       FROM calls WHERE id != 'CALL-PHONE' ORDER BY startedAt`,
    ),
    [
      {
        id: 'CALL-GROUP',
        startedAt: '2026-09-05T18:30:00.000000Z',
        duration: 600,
        serviceProvider: 'com.apple.FaceTime',
        kind: 'faceTimeVideo',
        kindCode: 8,
        category: 'video',
        categoryCode: 2,
        outgoing: 0,
        answered: 1,
        read: 1,
        hasMessage: null,
        address: null,
        name: null,
        location: null,
        isoCountryCode: null,
        handleType: 3,
        initiatorType: 3,
        initiatorValue: 'ada@example.com',
        initiatorNormalizedValue: 'ada@example.com',
        numberAvailability: null,
        disconnectedCause: null,
        originatingDeviceName: null,
        conversationId: '01234567-89AB-CDEF-0123-456789ABCDEF',
        participantGroupUuid: 'FEDCBA98-7654-3210-FEDC-BA9876543210',
      },
      {
        id: 'CALL-WITHHELD',
        startedAt: '2026-09-10T08:00:00.000000Z',
        duration: 0,
        serviceProvider: 'com.apple.Telephony',
        kind: 'phone',
        kindCode: 1,
        category: 'audio',
        categoryCode: 1,
        outgoing: 0,
        answered: 0,
        read: 0,
        hasMessage: null,
        address: null,
        name: null,
        location: null,
        isoCountryCode: null,
        handleType: null,
        initiatorType: null,
        initiatorValue: null,
        initiatorNormalizedValue: null,
        numberAvailability: 1,
        disconnectedCause: null,
        originatingDeviceName: null,
        conversationId: null,
        participantGroupUuid: null,
      },
      {
        id: 'CALL-NEW-KIND',
        startedAt: '2026-09-12T12:00:00.000000Z',
        duration: null,
        serviceProvider: null,
        kind: null,
        kindCode: 64,
        category: null,
        categoryCode: 3,
        outgoing: null,
        answered: null,
        read: null,
        hasMessage: null,
        address: null,
        name: null,
        location: null,
        isoCountryCode: null,
        handleType: null,
        initiatorType: null,
        initiatorValue: null,
        initiatorNormalizedValue: null,
        numberAvailability: null,
        disconnectedCause: null,
        originatingDeviceName: null,
        conversationId: null,
        participantGroupUuid: null,
      },
      {
        id: 'CALL-FACETIME-AUDIO',
        startedAt: '2026-09-15T20:00:00.000000Z',
        duration: 30,
        serviceProvider: 'com.apple.FaceTime',
        kind: 'faceTimeAudio',
        kindCode: 16,
        category: 'audio',
        categoryCode: 1,
        outgoing: 1,
        answered: 1,
        read: 1,
        hasMessage: null,
        address: null,
        name: null,
        location: null,
        isoCountryCode: null,
        handleType: null,
        initiatorType: null,
        initiatorValue: null,
        initiatorNormalizedValue: null,
        numberAvailability: null,
        disconnectedCause: null,
        originatingDeviceName: null,
        conversationId: null,
        participantGroupUuid: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT callId, type, value, normalizedValue FROM callParticipants ORDER BY callId, value',
    ),
    [
      {
        callId: 'CALL-GROUP',
        type: 3,
        value: 'ada@example.com',
        normalizedValue: 'ada@example.com',
      },
      {
        callId: 'CALL-GROUP',
        type: 3,
        value: 'alan@example.com',
        normalizedValue: 'alan@example.com',
      },
      {
        callId: 'CALL-GROUP',
        type: 3,
        value: 'grace@example.com',
        normalizedValue: 'grace@example.com',
      },
      {
        callId: 'CALL-PHONE',
        type: 2,
        value: '+1 (555) 010-0100',
        normalizedValue: '+15550100100',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, "all", incoming, outgoing, last, lifetime FROM callTimers',
    ),
    [
      {
        id: 1,
        all: 0,
        incoming: 3600,
        outgoing: 7200,
        last: 125.5,
        lifetime: 10800,
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, callId, mediaType, assetId FROM emergencyMediaItems ORDER BY id',
    ),
    [
      { id: 1, callId: 'CALL-GROUP', mediaType: 1, assetId: 'ASSET-1' },
      { id: 2, callId: null, mediaType: 2, assetId: 'ASSET-2' },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT id, callId, type, count FROM saintDavidsCounts ORDER BY id',
    ),
    [
      { id: 1, callId: 'CALL-PHONE', type: 4, count: 2 },
      { id: 2, callId: null, type: 7, count: 1 },
    ],
  );
  assert.deepEqual(counts(second), unchanged);
});

test('a call linked twice to the same handle loads one participant, and the next run diffs cleanly', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  {
    using store = new DatabaseSync(path);
    store.exec(`
      INSERT INTO ZHANDLE (Z_PK, Z_ENT, ZTYPE, ZVALUE, ZNORMALIZEDVALUE) VALUES (6, 4, 2, '+1 (555) 010-0100', '+15550100100');
      INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (1, 6);
    `);
  }
  const run = await pipeline(new AppleCallHistorySource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');

  await run.run();
  const second = await run.run();

  assert.deepEqual(
    rows(
      out,
      "SELECT callId, value FROM callParticipants WHERE callId = 'CALL-PHONE'",
    ),
    [{ callId: 'CALL-PHONE', value: '+1 (555) 010-0100' }],
  );
  assert.deepEqual(counts(second), unchanged);
});

test('a call deleted as Core Data deletes it removes its rows, and edited records update in place', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  const run = await pipeline(new AppleCallHistorySource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  {
    // CallRecord cascades to its participant handles and emergency media and
    // nullifies its initiator, whose handle row stays.
    using store = new DatabaseSync(path);
    store.exec(`
      DELETE FROM ZHANDLE WHERE Z_PK IN (SELECT Z_4REMOTEPARTICIPANTHANDLES FROM Z_2REMOTEPARTICIPANTHANDLES WHERE Z_2REMOTEPARTICIPANTCALLS = 2);
      DELETE FROM Z_2REMOTEPARTICIPANTHANDLES WHERE Z_2REMOTEPARTICIPANTCALLS = 2;
      DELETE FROM ZEMERGENCYMEDIAITEM WHERE ZUPLOADEDFORCALL = 2;
      DELETE FROM ZCALLRECORD WHERE Z_PK = 2;
      UPDATE ZCALLRECORD SET ZREAD = 1 WHERE ZUNIQUE_ID = 'CALL-WITHHELD';
      UPDATE ZCALLDBPROPERTIES SET ZTIMER_LIFETIME = 10900, ZTIMER_LAST = 100;
    `);
  }

  const changed = await run.run();

  assert.deepEqual(counts(changed), {
    calls: { count: 1, deleted: 1 },
    callParticipants: { count: 0, deleted: 3 },
    callTimers: { count: 1, deleted: 0 },
    emergencyMediaItems: { count: 0, deleted: 1 },
    saintDavidsCounts: { count: 0, deleted: 0 },
  });
  assert.deepEqual(rows(out, 'SELECT id, read FROM calls ORDER BY id'), [
    { id: 'CALL-FACETIME-AUDIO', read: 1 },
    { id: 'CALL-NEW-KIND', read: null },
    { id: 'CALL-PHONE', read: 1 },
    { id: 'CALL-WITHHELD', read: 1 },
  ]);
  assert.deepEqual(rows(out, 'SELECT callId FROM callParticipants'), [
    { callId: 'CALL-PHONE' },
  ]);
  assert.deepEqual(rows(out, 'SELECT id FROM emergencyMediaItems'), [
    { id: 2 },
  ]);
  assert.deepEqual(rows(out, 'SELECT last, lifetime FROM callTimers'), [
    { last: 100, lifetime: 10900 },
  ]);
});

test('a date range loads the calls that started in it and only their records', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  const scope: ImportScope = {
    startAt: '2026-09-05T18:30:00.000Z',
    endAt: '2026-09-10T08:00:00.000Z',
  };
  const source = new AppleCallHistorySource(path, scope);
  const out = join(dir.path, 'out.sqlite');

  await (await pipeline(source, dir.path)).run();

  assert.deepEqual(rows(out, 'SELECT id FROM calls'), [{ id: 'CALL-GROUP' }]);
  assert.deepEqual(rows(out, 'SELECT DISTINCT callId FROM callParticipants'), [
    { callId: 'CALL-GROUP' },
  ]);
  assert.equal(
    rows(out, 'SELECT count(*) AS n FROM callParticipants')[0]?.n,
    3,
  );
  assert.deepEqual(
    rows(out, 'SELECT id, callId FROM emergencyMediaItems ORDER BY id'),
    [
      { id: 1, callId: 'CALL-GROUP' },
      { id: 2, callId: null },
    ],
  );
  assert.deepEqual(rows(out, 'SELECT id, callId FROM saintDavidsCounts'), [
    { id: 2, callId: null },
  ]);
  assert.equal(rows(out, 'SELECT count(*) AS n FROM callTimers')[0]?.n, 1);
  assert.deepEqual(source.coverage(source.calls).selection, scope);
});

test('a one-millisecond range selects the call that started within it, to the microsecond', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  // CALL-PHONE started at 10:00:00.250123.
  const source = new AppleCallHistorySource(path, {
    startAt: '2026-09-01T10:00:00.250Z',
    endAt: '2026-09-01T10:00:00.251Z',
  });
  const out = join(dir.path, 'out.sqlite');

  await (await pipeline(source, dir.path)).run();

  assert.deepEqual(rows(out, 'SELECT id, startedAt FROM calls'), [
    { id: 'CALL-PHONE', startedAt: '2026-09-01T10:00:00.250123Z' },
  ]);
});

test('participants load whatever entity numbers this macOS gives the join table', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  {
    // Core Data names the join table after entity numbers that change
    // between model versions.
    using store = new DatabaseSync(path);
    store.exec(`
      ALTER TABLE Z_2REMOTEPARTICIPANTHANDLES RENAME TO Z_7REMOTEPARTICIPANTHANDLES;
      ALTER TABLE Z_7REMOTEPARTICIPANTHANDLES RENAME COLUMN Z_2REMOTEPARTICIPANTCALLS TO Z_7REMOTEPARTICIPANTCALLS;
      ALTER TABLE Z_7REMOTEPARTICIPANTHANDLES RENAME COLUMN Z_4REMOTEPARTICIPANTHANDLES TO Z_9REMOTEPARTICIPANTHANDLES;
    `);
  }
  const out = join(dir.path, 'out.sqlite');

  await (await pipeline(new AppleCallHistorySource(path), dir.path)).run();

  assert.deepEqual(
    rows(
      out,
      'SELECT callId, value FROM callParticipants ORDER BY callId, value',
    ),
    [
      { callId: 'CALL-GROUP', value: 'ada@example.com' },
      { callId: 'CALL-GROUP', value: 'alan@example.com' },
      { callId: 'CALL-GROUP', value: 'grace@example.com' },
      { callId: 'CALL-PHONE', value: '+1 (555) 010-0100' },
    ],
  );
});

test('a store without the participant join table fails the participants stream by name while the others load', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  {
    using store = new DatabaseSync(path);
    store.exec('DROP TABLE Z_2REMOTEPARTICIPANTHANDLES');
  }
  const out = join(dir.path, 'out.sqlite');

  await assert.rejects(
    (await pipeline(new AppleCallHistorySource(path), dir.path)).run(),
    (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, 1);
      const [cause] = error.errors;
      assert.ok(cause instanceof CallHistorySchemaError);
      assert.match(cause.message, /Z_\*REMOTEPARTICIPANTHANDLES/);
      return true;
    },
  );

  assert.equal(rows(out, 'SELECT count(*) AS n FROM calls')[0]?.n, 5);
});

test('a store that stops being readable fails every stream, naming Full Disk Access, and keeps what loaded', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  const run = await pipeline(new AppleCallHistorySource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // chmod stands in for macOS withdrawing Full Disk Access: SQLite reports
  // CANTOPEN here and AUTH under a privacy denial, and both are unavailable.
  await chmod(path, 0o000);

  try {
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, 5);
      for (const cause of error.errors) {
        assert.ok(cause instanceof CallHistoryUnavailableError);
        assert.match(cause.message, /Full Disk Access/);
        assert.ok(cause.message.includes(path));
      }
      assert.deepEqual(failureTypes(error), ['config']);
      return true;
    });
  } finally {
    await chmod(path, 0o644);
  }

  assert.equal(rows(out, 'SELECT count(*) AS n FROM calls')[0]?.n, 5);
  assert.deepEqual(counts(await run.run()), unchanged);
});

test('a store missing a column this reader reads fails every stream by name and keeps what loaded', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  const run = await pipeline(new AppleCallHistorySource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  {
    using store = new DatabaseSync(path);
    store.exec('ALTER TABLE ZCALLRECORD DROP COLUMN ZDURATION');
  }

  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.errors.length, 5);
    for (const cause of error.errors) {
      assert.ok(cause instanceof CallHistorySchemaError);
      assert.match(cause.message, /ZCALLRECORD\.ZDURATION/);
    }
    return true;
  });

  assert.equal(rows(out, 'SELECT count(*) AS n FROM calls')[0]?.n, 5);
  assert.equal(
    rows(out, 'SELECT count(*) AS n FROM callParticipants')[0]?.n,
    4,
  );
});

test('a Call History watch loads each commit while callhistoryd keeps its store open', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-'));
  const path = join(dir.path, 'CallHistory.storedata');
  callHistoryFixture(path);
  const run = await pipeline(new AppleCallHistorySource(path), dir.path);
  // callhistoryd holds its connection, and so its WAL, open the whole time.
  using callhistoryd = new DatabaseSync(path);
  const controller = new AbortController();
  const batches: Record<string, { count: number; deleted: number }>[] = [];

  for await (const { outcomes } of run.watch({
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(counts(outcomes));
    if (batches.length === 1)
      callhistoryd.exec(`
        INSERT INTO ZHANDLE (Z_PK, Z_ENT, ZTYPE, ZVALUE) VALUES (7, 4, 2, '+15550100200');
        INSERT INTO ZCALLRECORD (Z_PK, Z_ENT, ZUNIQUE_ID, ZDATE, ZCALLTYPE) VALUES (5, 2, 'CALL-NEW', ${coreData('2026-10-06T09:00:00.000Z')}, 1);
        INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (5, 7);
      `);
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  assert.deepEqual(batches, [
    {
      calls: { count: 5, deleted: 0 },
      callParticipants: { count: 4, deleted: 0 },
      callTimers: { count: 1, deleted: 0 },
      emergencyMediaItems: { count: 2, deleted: 0 },
      saintDavidsCounts: { count: 2, deleted: 0 },
    },
    {
      ...unchanged,
      calls: { count: 1, deleted: 0 },
      callParticipants: { count: 1, deleted: 0 },
    },
  ]);
});

test('this Mac’s call history loads every stream, one row per stored record', async (t) => {
  if (process.platform !== 'darwin')
    return t.skip('Call History requires macOS');
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-calls-live-'));
  const out = join(dir.path, 'out.sqlite');

  try {
    await (await pipeline(new AppleCallHistorySource(), dir.path)).run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every(
        (cause) => cause instanceof CallHistoryUnavailableError,
      )
    )
      return t.skip('no Full Disk Access to the call history store');
    throw error;
  }

  // Counted, never printed: these are the user's own calls.
  const stored = (sql: string) => Number(rows(callHistoryStorePath, sql)[0]?.n);
  const loaded = (sql: string) => Number(rows(out, sql)[0]?.n);
  assert.equal(
    loaded('SELECT count(*) AS n FROM calls'),
    stored('SELECT count(*) AS n FROM ZCALLRECORD'),
  );
  // The join table's name is this macOS version's (Z_2…).
  assert.equal(
    loaded('SELECT count(*) AS n FROM callParticipants'),
    stored(
      'SELECT count(*) AS n FROM (SELECT DISTINCT link.Z_2REMOTEPARTICIPANTCALLS, handle.ZTYPE, handle.ZVALUE FROM Z_2REMOTEPARTICIPANTHANDLES AS link JOIN ZHANDLE AS handle ON handle.Z_PK = link.Z_4REMOTEPARTICIPANTHANDLES)',
    ),
  );
  assert.equal(
    loaded('SELECT count(*) AS n FROM callTimers'),
    stored('SELECT count(*) AS n FROM ZCALLDBPROPERTIES'),
  );
  assert.equal(
    loaded('SELECT count(*) AS n FROM emergencyMediaItems'),
    stored('SELECT count(*) AS n FROM ZEMERGENCYMEDIAITEM'),
  );
  assert.equal(
    loaded('SELECT count(*) AS n FROM saintDavidsCounts'),
    stored('SELECT count(*) AS n FROM ZSAINTDAVIDSCOUNTS'),
  );
  // Every call type and category on this Mac is one the reader knows.
  assert.equal(
    loaded(
      'SELECT count(*) AS n FROM calls WHERE (kindCode IS NOT NULL AND kind IS NULL) OR (categoryCode IS NOT NULL AND category IS NULL)',
    ),
    0,
  );
});
