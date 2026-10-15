import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempDisposable,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { isDictionary, readPlist } from '@workspace/codec-plist';
import {
  Connection,
  Copy,
  Pipeline,
  PipelineError,
  type Stream,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import {
  type ClockLocation,
  ClockUnavailableError,
  clockLocation,
} from '@workspace/sdk-apple-clock/clock-store';

import { AppleClockSource } from './apple-clock-source.ts';

function binary(value: unknown): Buffer {
  return execFileSync(
    '/usr/bin/plutil',
    ['-convert', 'binary1', '-o', '-', '-'],
    { input: JSON.stringify(value) },
  );
}
const city = {
  city: {
    identifier: 295,
    name: 'Tokyo',
    countryName: 'Japan',
    timeZone: 'Asia/Tokyo',
    latitude: 35.7,
    longitude: 139.7667,
    localeCode: 'JP',
    displayNameIncludingCountryUsesOnlyCountry: false,
  },
  languageCode: 'en',
  type: 2,
};
const watch = {
  $MTStopwatch: {
    MTStopwatchIdentifier: '11111111-1111-4111-8111-111111111111',
    MTStopwatchState: 1,
    MTStopwatchCurrentInterval: 6.431408047676086,
    MTStopwatchOffset: 6.435943007469177,
    MTStopwatchPreviousLapsTotalInterval: 3.832172989845276,
    MTStopwatchLaps: [3.832172989845276],
  },
};

async function fixture(directory: string): Promise<ClockLocation> {
  const location = {
    database: join(directory, 'local.sqlite'),
    cities: join(directory, 'cities.plist'),
    stopwatches: join(directory, 'daemon.plist'),
  };
  using db = new DatabaseSync(location.database);
  db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE ZMTCDALARM (Z_PK INTEGER PRIMARY KEY, ZMTID BLOB, ZTITLE TEXT, ZENABLED INTEGER, ZHOUR REAL, ZMINUTE REAL, ZDAY REAL, ZMONTH REAL, ZYEAR REAL, ZREPEATSCHEDULE REAL, ZALLOWSSNOOZE INTEGER, ZSNOOZEDURATION REAL, ZSLEEPALARM INTEGER, ZSLEEPSCHEDULE INTEGER, ZSILENTMODEOPTIONS REAL, ZCOORDINATIONPOLICY REAL, ZDISMISSEDACTION REAL, ZDISMISSEDDATE REAL, ZFIREDDATE REAL, ZKEEPOFFUNTILDATE REAL, ZLASTMODIFIEDDATE REAL, ZSNOOZEFIREDATE REAL, ZSOUND INTEGER, ZSIRICONTEXT BLOB);
CREATE TABLE ZMTCDTIMER (Z_PK INTEGER PRIMARY KEY, ZMTID BLOB, ZTITLE TEXT, ZSTATE REAL, ZDURATION REAL, ZSOUND INTEGER, ZDISMISSEDDATE REAL, ZFIREDDATE REAL, ZLASTMODIFIEDDATE REAL, ZTIMERURL TEXT, ZSIRICONTEXT BLOB, ZTIMERCONTEXT BLOB, ZFIRETIME BLOB);
CREATE TABLE ZMTCDTIMERDURATION (Z_PK INTEGER PRIMARY KEY, ZTITLE TEXT, ZDURATION REAL, ZISFAVORITE INTEGER, ZLATEST INTEGER, ZVALIDRECENT INTEGER, ZLASTMODIFIED REAL, ZSOUND INTEGER);
CREATE TABLE ZMTCDSOUND (Z_PK INTEGER PRIMARY KEY, ZSOUNDTYPE REAL, ZVOLUMELEVEL REAL, ZTONEIDENTIFIER TEXT, ZVIBRATIONIDENTIFIER TEXT, ZMEDIAITEMIDENTIFIER INTEGER);
CREATE TABLE ZMTCDCALENDARRELEASE (Z_PK INTEGER PRIMARY KEY, ZREGION TEXT, ZYEAR TEXT, ZRELEASEDATE REAL, ZLASTCHECKEDDATE REAL);
CREATE TABLE ZMTCDMAKEUPDAY (Z_PK INTEGER PRIMARY KEY, ZDATE REAL, ZTYPE REAL, ZCALENDARRELEASE INTEGER);
CREATE TABLE ZMTCDREPORT (Z_PK INTEGER PRIMARY KEY, ZDATE REAL, ZCONCERNS REAL);
`);
  db.exec(`
    INSERT INTO ZMTCDALARM (Z_PK,ZMTID,ZTITLE,ZHOUR,ZMINUTE,ZENABLED,ZREPEATSCHEDULE,ZSOUND,ZLASTMODIFIEDDATE) VALUES (1,x'22222222222242228222222222222222','Synthetic alarm',23,59,0,1,1,813396914.314441);
    INSERT INTO ZMTCDSOUND (Z_PK,ZSOUNDTYPE,ZVOLUMELEVEL,ZTONEIDENTIFIER,ZVIBRATIONIDENTIFIER,ZMEDIAITEMIDENTIFIER) VALUES (1,2,-1,'system:Radial','',9007199254740993);
    INSERT INTO ZMTCDTIMER (Z_PK,ZMTID,ZTITLE,ZSTATE,ZDURATION,ZSOUND) VALUES (1,x'33333333333343338333333333333333','Synthetic timer',2,900,1);
    INSERT INTO ZMTCDTIMERDURATION (Z_PK,ZTITLE,ZDURATION,ZISFAVORITE,ZLATEST,ZVALIDRECENT,ZSOUND) VALUES (1,'Synthetic timer',900,1,1,1,1);
    INSERT INTO ZMTCDCALENDARRELEASE (Z_PK,ZREGION,ZYEAR,ZRELEASEDATE) VALUES (1,'CN','2026',800000000.125);
    INSERT INTO ZMTCDMAKEUPDAY (Z_PK,ZDATE,ZTYPE,ZCALENDARRELEASE) VALUES (1,800000001,1,1);
    INSERT INTO ZMTCDREPORT (Z_PK,ZDATE,ZCONCERNS) VALUES (1,800000002,2);
  `);
  await writeFile(location.cities, binary({ cities: [city] }));
  await writeFile(
    location.stopwatches,
    binary({ MTStopwatches: { MTStopwatches: [watch] } }),
  );
  return location;
}

async function pipeline(
  source: AppleClockSource,
  directory: string,
  selected?: readonly Stream[],
  syncMode: 'incremental' | 'full_refresh' = 'incremental',
) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  installSQLiteCatalog(destination);
  const streams = selected ?? (await source.discover()).streams;
  return new Pipeline({
    connections: [
      new Connection({
        name: 'clock',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(
              stream,
              destination
                .table(stream.name)
                .withReaderView('reader_' + stream.name),
              {
                id: stream.name,
                syncMode,
                destinationSyncMode:
                  syncMode === 'incremental'
                    ? 'append_dedup'
                    : 'overwrite_dedup',
              },
            ),
        ),
      }),
    ],
  });
}
function rows(directory: string, sql: string) {
  using db = new DatabaseSync(join(directory, 'out.sqlite'), {
    readOnly: true,
  });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

test('failed Clock stores preserve rows and checkpoints while independent stores keep importing', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'clock-failure-'));
  const location = await fixture(dir.path);
  const source = new AppleClockSource(location);
  const run = await pipeline(source, dir.path);
  await run.run();
  const original = await readFile(location.stopwatches);
  await writeFile(
    location.stopwatches,
    binary({ MTStopwatches: { MTStopwatches: 'broken' } }),
  );
  await writeFile(
    location.cities,
    binary({
      cities: [city, { ...city, city: { ...city.city, name: 'Osaka' } }],
    }),
  );
  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors.every((cause) => cause instanceof TypeError));
    return true;
  });
  assert.equal(rows(dir.path, 'select count(*) n from stopwatches')[0]?.n, 1);
  assert.equal(rows(dir.path, 'select count(*) n from stopwatchLaps')[0]?.n, 1);
  assert.equal(rows(dir.path, 'select count(*) n from worldClocks')[0]?.n, 2);
  await writeFile(location.stopwatches, original);
  assert.ok(
    (await run.run()).every(
      ({ count, deleted }) => count === 0 && deleted === 0,
    ),
  );
  await rename(location.database, location.database + '.hidden');
  try {
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, 7);
      assert.ok(
        error.errors.every((cause) => cause instanceof ClockUnavailableError),
      );
      assert.ok(
        error.results
          .flatMap(({ failures }) => failures)
          .every(({ failureType }) => failureType === 'config'),
      );
      return true;
    });
  } finally {
    await rename(location.database + '.hidden', location.database);
  }
  assert.equal(rows(dir.path, 'select count(*) n from alarms')[0]?.n, 1);
  assert.ok(
    (await run.run()).every(
      ({ count, deleted }) => count === 0 && deleted === 0,
    ),
  );
  using upstream = new DatabaseSync(location.database);
  upstream.exec('ALTER TABLE ZMTCDALARM DROP COLUMN ZHOUR');
  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.errors.length, 7);
    assert.ok(
      error.errors.every(
        (cause) =>
          cause instanceof Error && /ZMTCDALARM.ZHOUR/.test(cause.message),
      ),
    );
    return true;
  });
  assert.equal(rows(dir.path, 'select count(*) n from alarms')[0]?.n, 1);
});

// Synthetic binary plists matching MTStorageWriter/NSKeyedArchiver, including
// a native plist date and an archived NSDate with sub-millisecond seconds.
const runningStopwatch = Buffer.from(
  'YnBsaXN0MDDRAQJdTVRTdG9wd2F0Y2hlc9EBA6EE0QUGXCRNVFN0b3B3YXRjaNgHCAkKCwwNDg8QEQ8UFRYXXxAaTVRTdG9wd2F0Y2hDdXJyZW50SW50ZXJ2YWxfEBVNVFN0b3B3YXRjaElkZW50aWZpZXJfEA9NVFN0b3B3YXRjaExhcHNfEBFNVFN0b3B3YXRjaE9mZnNldF8QJE1UU3RvcHdhdGNoUHJldmlvdXNMYXBzVG90YWxJbnRlcnZhbF8QFE1UU3RvcHdhdGNoU3RhcnREYXRlXxAQTVRTdG9wd2F0Y2hTdGF0ZV8QEE1UU3RvcHdhdGNoVGl0bGUjAAAAAAAAAABfECQxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTGiEhMjP/QAAAAAAAAjQAQAAAAAAAAjQA4AAAAAAAAzQcfXhAAPzWgQAlVQcm9iZQAIAAsAGQAcAB4AIQAuAD8AXAB0AIYAmgDBANgA6wD+AQcBLgExAToBQwFMAVUBVwAAAAAAAAIBAAAAAAAAABgAAAAAAAAAAAAAAAAAAAFd',
  'base64',
);
const pausedTimer = Buffer.from(
  'YnBsaXN0MDDUAQIDBAUGEhVZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKjBwgNVSRudWxs0gkKCwxWJGNsYXNzXxATTVRUaW1lclRpbWVJbnRlcnZhbIACI0Be0AAAAAAA0g4PEApYJGNsYXNzZXNaJGNsYXNzbmFtZaIKEVhOU09iamVjdNETFFRyb290gAESAAGGoAgRGyQpMkRITlNacHJ7gImUl6CjqKoAAAAAAAABAQAAAAAAAAAWAAAAAAAAAAAAAAAAAAAArw==',
  'base64',
);
const runningTimer = Buffer.from(
  'YnBsaXN0MDDUAQIDBAUGGh1ZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKlBwgNExdVJG51bGzSCQoLDFYkY2xhc3NfEA9NVFRpbWVyVGltZURhdGWAAoAD0g4PEBFYJGNsYXNzZXNaJGNsYXNzbmFtZaIREltNVFRpbWVyRGF0ZVhOU09iamVjdNIJFBUWV05TLnRpbWWABCNBx9eEAA/NaNIODxgZohkSVk5TRGF0ZdEbHFRyb290gAESAAGGoAgRGyQpMkRKUFVcbnByd4CLjpqjqLCyu8DDys3S1AAAAAAAAAEBAAAAAAAAAB4AAAAAAAAAAAAAAAAAAADZ',
  'base64',
);

test('Clock streams retain complete stored facts and diff unchanged, changed and deleted objects', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'clock-snapshot-'));
  const location = await fixture(dir.path);
  await writeFile(location.stopwatches, runningStopwatch);
  using upstream = new DatabaseSync(location.database);
  upstream.prepare('UPDATE ZMTCDTIMER SET ZFIRETIME = ?').run(runningTimer);
  const run = await pipeline(new AppleClockSource(location), dir.path);
  const first = await run.run();
  assert.deepEqual(
    Object.fromEntries(first.map(({ copy, count }) => [copy.from.name, count])),
    {
      alarms: 1,
      timers: 1,
      timerDurations: 1,
      sounds: 1,
      calendarReleases: 1,
      makeupDays: 1,
      reports: 1,
      worldClocks: 1,
      stopwatches: 1,
      stopwatchLaps: 2,
    },
  );
  assert.deepEqual(
    rows(
      dir.path,
      'select id,title,hour,minute,enabled,repeatSchedule,soundId,modifiedAt,dismissedAt from alarms',
    ),
    [
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Synthetic alarm',
        hour: 23,
        minute: 59,
        enabled: 0,
        repeatSchedule: 1,
        soundId: '1',
        modifiedAt: '2026-10-11T07:35:14.314441Z',
        dismissedAt: null,
      },
    ],
  );
  assert.deepEqual(
    rows(
      dir.path,
      'select id,CAST(mediaItemId AS TEXT) mediaItemId,volume,toneId from sounds',
    ),
    [
      {
        id: '1',
        mediaItemId: '9007199254740993',
        volume: -1,
        toneId: 'system:Radial',
      },
    ],
  );
  assert.deepEqual(
    rows(
      dir.path,
      'select fireAt,remainingSeconds,duration,soundId from timers',
    ),
    [
      {
        fireAt: '2026-05-09T06:13:20.123456Z',
        remainingSeconds: null,
        duration: 900,
        soundId: '1',
      },
    ],
  );
  const fireTime = rows(dir.path, 'select fireTime from timers')[0]?.fireTime;
  assert.equal(typeof fireTime, 'string');
  const archive: unknown = JSON.parse(String(fireTime));
  assert.ok(isDictionary(archive));
  assert.ok(Array.isArray(archive.$objects));
  assert.deepEqual(archive.$objects[3], {
    $class: { $uid: 4 },
    'NS.time': 800000000.123456,
  });
  assert.deepEqual(
    rows(dir.path, 'select startedAt,stateCode,title from stopwatches'),
    [
      {
        startedAt: '2026-05-09T06:13:20.123456Z',
        stateCode: 2,
        title: 'Probe',
      },
    ],
  );
  assert.deepEqual(
    rows(
      dir.path,
      'select stopwatchId,position,interval from stopwatchLaps order by position',
    ),
    [
      {
        stopwatchId: '11111111-1111-4111-8111-111111111111',
        position: 0,
        interval: 1.25,
      },
      {
        stopwatchId: '11111111-1111-4111-8111-111111111111',
        position: 1,
        interval: 2.5,
      },
    ],
  );
  assert.deepEqual(
    rows(
      dir.path,
      'select favorite,latest,validRecent,soundId from timerDurations',
    ),
    [{ favorite: 1, latest: 1, validRecent: 1, soundId: '1' }],
  );
  assert.deepEqual(
    rows(dir.path, 'select calendarReleaseId,typeCode from makeupDays'),
    [{ calendarReleaseId: '1', typeCode: 1 }],
  );
  assert.equal(
    rows(dir.path, 'select region from calendarReleases')[0]?.region,
    'CN',
  );
  assert.equal(rows(dir.path, 'select concerns from reports')[0]?.concerns, 2);
  assert.deepEqual(
    rows(dir.path, 'select position,name,timeZone,latitude from worldClocks'),
    [{ position: 0, name: 'Tokyo', timeZone: 'Asia/Tokyo', latitude: 35.7 }],
  );
  assert.ok(
    (await run.run()).every(
      ({ count, deleted }) => count === 0 && deleted === 0,
    ),
  );
  await using full = await mkdtempDisposable(join(tmpdir(), 'clock-full-'));
  const fullRun = await pipeline(
    new AppleClockSource(location),
    full.path,
    undefined,
    'full_refresh',
  );
  assert.equal(
    (await fullRun.run()).reduce((sum, { count }) => sum + count, 0),
    11,
  );
  assert.deepEqual(
    rows(full.path, 'select id,startedAt,stateCode from stopwatches'),
    rows(dir.path, 'select id,startedAt,stateCode from stopwatches'),
  );
  upstream.exec(
    "UPDATE ZMTCDALARM SET ZTITLE='Changed'; DELETE FROM ZMTCDREPORT; DELETE FROM ZMTCDMAKEUPDAY; DELETE FROM ZMTCDCALENDARRELEASE; DELETE FROM ZMTCDTIMERDURATION;",
  );
  upstream
    .prepare('UPDATE ZMTCDTIMER SET ZFIRETIME=?, ZSTATE=2')
    .run(pausedTimer);
  await writeFile(location.cities, binary({ cities: [] }));
  await writeFile(
    location.stopwatches,
    binary({ MTStopwatches: { MTStopwatches: [] } }),
  );
  const second = await run.run();
  assert.equal(
    second.reduce((sum, { deleted }) => sum + deleted, 0),
    8,
  );
  assert.equal(rows(dir.path, 'select title from alarms')[0]?.title, 'Changed');
  assert.deepEqual(
    rows(dir.path, 'select fireAt,remainingSeconds from timers'),
    [{ fireAt: null, remainingSeconds: 123.25 }],
  );
  assert.equal(
    (await fullRun.run()).reduce((sum, { count }) => sum + count, 0),
    3,
  );
  for (const { copy } of first) {
    assert.ok(copy.from.jsonSchema.properties);
    const columns = Object.entries(copy.from.jsonSchema.properties)
      .map(([name, field]) =>
        field.format === 'int64' ? `CAST(${name} AS TEXT) AS ${name}` : name,
      )
      .join(',');
    assert.deepEqual(
      rows(full.path, `select ${columns} from ${copy.from.name}`),
      rows(dir.path, `select ${columns} from ${copy.from.name}`),
    );
  }
  upstream.exec(
    'DELETE FROM ZMTCDALARM; DELETE FROM ZMTCDTIMER; DELETE FROM ZMTCDSOUND;',
  );
  assert.equal(
    (await run.run()).reduce((sum, { deleted }) => sum + deleted, 0),
    3,
  );
  assert.ok(
    (await run.run()).every(
      ({ count, deleted }) => count === 0 && deleted === 0,
    ),
  );
});

test('a Clock watch follows selected database and preference changes and cancels cleanly', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'clock-watch-'));
  const location = await fixture(dir.path);
  const source = new AppleClockSource(location);
  const run = await pipeline(source, dir.path, [
    source.alarms,
    source.worldClocks,
    source.stopwatchLaps,
  ]);
  using upstream = new DatabaseSync(location.database);
  const controller = new AbortController();
  const batches: { streams: string[]; count: number; deleted: number }[] = [];
  try {
    for await (const { outcomes } of run.watch({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })) {
      batches.push({
        streams: outcomes.map(({ copy }) => copy.from.name).sort(),
        count: outcomes.reduce((sum, { count }) => sum + count, 0),
        deleted: outcomes.reduce((sum, { deleted }) => sum + deleted, 0),
      });
      if (batches.length === 1)
        upstream.exec("UPDATE ZMTCDALARM SET ZTITLE='Watch update'");
      else if (batches.length === 2)
        await writeFile(location.cities, binary({ cities: [] }));
      else if (batches.length === 3)
        await writeFile(
          location.stopwatches,
          binary({ MTStopwatches: { MTStopwatches: [] } }),
        );
      else controller.abort();
    }
  } finally {
    controller.abort();
  }
  assert.deepEqual(batches, [
    {
      streams: ['alarms', 'stopwatchLaps', 'worldClocks'],
      count: 3,
      deleted: 0,
    },
    { streams: ['alarms'], count: 1, deleted: 0 },
    { streams: ['worldClocks'], count: 0, deleted: 1 },
    { streams: ['stopwatchLaps'], count: 0, deleted: 1 },
  ]);
  assert.equal(
    rows(dir.path, 'select title from alarms')[0]?.title,
    'Watch update',
  );
  const stopped = source.watch({
    streams: [source.alarms],
    signal: AbortSignal.abort(),
  });
  assert.equal((await stopped.next()).done, true);
});

test('a Clock watch goes on when a preference file is removed, and loads it again when it returns', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'clock-watch-'));
  const location = await fixture(dir.path);
  const source = new AppleClockSource(location);
  const run = await pipeline(source, dir.path, [
    source.alarms,
    source.worldClocks,
    source.stopwatchLaps,
  ]);
  using upstream = new DatabaseSync(location.database);
  const controller = new AbortController();
  const errors: unknown[] = [];
  const batches: {
    streams: string[];
    count: number;
    failures: string[];
    cities: unknown[];
  }[] = [];
  try {
    for await (const { outcomes } of run.watch({
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    })) {
      const failures = outcomes.flatMap(({ failures }) => failures);
      errors.push(...failures.map(({ error }) => error));
      batches.push({
        streams: outcomes.map(({ copy }) => copy.from.name).sort(),
        count: outcomes.reduce((sum, { count }) => sum + count, 0),
        failures: failures.map(({ failureType }) => failureType),
        cities: rows(dir.path, 'select name from worldClocks').map(
          ({ name }) => name,
        ),
      });
      if (batches.length === 1) await rm(location.cities);
      else if (batches.length === 2)
        await writeFile(
          location.cities,
          binary({
            cities: [{ ...city, city: { ...city.city, name: 'Osaka' } }],
          }),
        );
      else if (batches.length === 3)
        upstream.exec("UPDATE ZMTCDALARM SET ZTITLE='After the return'");
      else controller.abort();
    }
  } finally {
    controller.abort();
  }
  assert.deepEqual(batches, [
    {
      streams: ['alarms', 'stopwatchLaps', 'worldClocks'],
      count: 3,
      failures: [],
      cities: ['Tokyo'],
    },
    {
      streams: ['worldClocks'],
      count: 0,
      failures: ['config'],
      cities: ['Tokyo'],
    },
    { streams: ['worldClocks'], count: 1, failures: [], cities: ['Osaka'] },
    { streams: ['alarms'], count: 1, failures: [], cities: ['Osaka'] },
  ]);
  assert.ok(errors.every((error) => error instanceof ClockUnavailableError));
  assert.equal(
    rows(dir.path, 'select title from alarms')[0]?.title,
    'After the return',
  );
});

test('this Mac Clock stores load read-only through the real pipeline', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Clock requires macOS');
  await using dir = await mkdtempDisposable(join(tmpdir(), 'clock-live-'));
  const run = await pipeline(new AppleClockSource(), dir.path);
  try {
    await run.run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every((cause) => cause instanceof ClockUnavailableError)
    )
      return t.skip('Clock stores are unavailable to this process');
    throw error;
  }
  using db = new DatabaseSync(clockLocation.database, { readOnly: true });
  for (const [table, stream] of [
    ['ZMTCDALARM', 'alarms'],
    ['ZMTCDTIMER', 'timers'],
    ['ZMTCDTIMERDURATION', 'timerDurations'],
    ['ZMTCDSOUND', 'sounds'],
    ['ZMTCDCALENDARRELEASE', 'calendarReleases'],
    ['ZMTCDMAKEUPDAY', 'makeupDays'],
    ['ZMTCDREPORT', 'reports'],
  ]) {
    assert.equal(
      rows(dir.path, `select count(*) n from ${stream}`)[0]?.n,
      db.prepare(`select count(*) n from ${table}`).get()?.n,
    );
  }
  const cities = await readPlist(clockLocation.cities);
  assert.ok(isDictionary(cities));
  assert.ok(Array.isArray(cities.cities));
  assert.equal(
    rows(dir.path, 'select count(*) n from worldClocks')[0]?.n,
    cities.cities.length,
  );
  const daemon = await readPlist(clockLocation.stopwatches);
  assert.ok(isDictionary(daemon));
  assert.ok(isDictionary(daemon.MTStopwatches));
  assert.ok(Array.isArray(daemon.MTStopwatches.MTStopwatches));
  assert.equal(
    rows(dir.path, 'select count(*) n from stopwatches')[0]?.n,
    daemon.MTStopwatches.MTStopwatches.length,
  );
  for (const { id } of rows(dir.path, 'select id from timers'))
    assert.match(String(id), /^[A-F0-9-]{36}$/);
});

test('a Clock watch keeps every stream current while its stores hold still', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'clock-current-'));
  const location = await fixture(dir.path);
  const source = new AppleClockSource(location);
  const data = join(dir.path, 'out.sqlite');
  const destination = new SQLiteDestination({ path: data });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  const { streams } = await source.discover();
  const watching = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(dir.path, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) => new Copy(stream, destination.table(stream.name)),
        ),
      }),
    ],
  }).watch({ signal: AbortSignal.timeout(30_000) });
  try {
    await watching.next();
    using out = new DatabaseSync(data, { readOnly: true });
    const status = out.prepare(
      'SELECT stream, status, last_successful_sync_at, current_as_of FROM stream_status',
    );
    const [pass] = out
      .prepare('SELECT started_at, completed_at FROM sync_attempts')
      .all();
    // Nothing changes, so only the watch's next check can move current_as_of.
    for (
      let tries = 0;
      status
        .all()
        .some(
          ({ current_as_of }) =>
            String(current_as_of) <= String(pass?.started_at),
        );
      tries++
    ) {
      if (tries > 100)
        assert.fail(`not current: ${JSON.stringify(status.all())}`);
      await sleep(100);
    }

    assert.equal(
      out.prepare('SELECT count(*) AS n FROM sync_attempts').get()?.n,
      1,
    );
    for (const row of status.all()) {
      assert.equal(row.status, 'succeeded', String(row.stream));
      assert.equal(row.last_successful_sync_at, pass?.completed_at);
    }
  } finally {
    await watching.return(undefined);
  }
});
