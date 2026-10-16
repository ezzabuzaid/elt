import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Docker, TestRun } from '@zukhruf/testing/docker';
import { Postgres } from '@zukhruf/testing/postgres';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import postgres from 'postgres';

import { Connection, Copy, Pipeline, PipelineError } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@workspace/elt-postgresql';
import { GoogleGrant, GoogleOAuthApp } from '@workspace/google-auth';

import { GoogleHealthSource } from './google-health-source.ts';

const databases = new Postgres({
  docker: new Docker({ testRun: TestRun.fromEnvironment(process.env) }),
});

const RAW = 'google_health';

type Warehouse = {
  sql: postgres.Sql;
  history: PostgresSyncHistory;
  destination: PostgresDestination;
  checkpoints: PostgresCheckpointStore;
};

// A real OAuth client over a stored grant; its first call mints a token at
// the token endpoint the test's server answers.
function signedIn() {
  return new GoogleOAuthApp({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  }).client(
    new GoogleGrant({
      kind: 'GOOGLE_BIGQUERY_OAUTH',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      scope: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
    }),
    ['https://www.googleapis.com/auth/googlehealth.sleep.readonly'],
  );
}

type Json = Record<string, unknown>;

/** What one Google Health account holds, as the API answers it. */
type Account = {
  identity?: Json;
  profile?: Json;
  settings?: Json;
  irnProfile?: Json;
  devices?: Json[];
  // Each data type's points, newest first, as the list call returns them.
  points?: Record<string, Json[]>;
  // A data type Google answers for every date, recorded or not.
  everyDay?: Record<string, (date: string) => Json>;
  // A rollup-only type's total for one day, or undefined for none.
  rollups?: Record<string, (date: string) => Json | undefined>;
  tcx?: Record<string, string>;
  // An answer that replaces Google's for the calls it matches.
  answer?: (url: URL) => Response | undefined;
};

const DAY_MS = 86_400_000;
const civilDate = (date: string) => {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
};
const isoDate = ({
  year,
  month,
  day,
}: {
  year: number;
  month: number;
  day: number;
}) =>
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/**
 * Google's side of the wire for one test, stubbed below fetch with msw: the
 * token endpoint and the Health API as probed live on 2026-10-15. Lists come
 * two points a page; a daily type answers every date from its filter's start,
 * and dates before it when there is no filter; a rollup answers each day of
 * its range. A type the account has no data for answers `{}`. Any other
 * request fails the test.
 */
function google(account: Account) {
  const requests: URL[] = [];
  const server = setupServer(
    http.post('https://oauth2.googleapis.com/token', () =>
      Response.json({ access_token: 'access-token', expires_in: 3600 }),
    ),
    http.all('https://health.googleapis.com/*', async ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const answered = account.answer?.(url);
      if (answered) return answered;
      const path = url.pathname.replace('/v4/', '');
      const singles: Record<string, Json | undefined> = {
        // Every account has an identity.
        'users/me/identity': account.identity ?? {
          healthUserId: '1',
          legacyUserId: 'ABC123',
          name: 'users/me/identity',
        },
        'users/me/profile': account.profile,
        'users/me/settings': account.settings,
        'users/me/irnProfile': account.irnProfile,
      };
      if (path in singles) return Response.json(singles[path] ?? {});
      if (path === 'users/me/pairedDevices')
        return Response.json({ pairedDevices: account.devices ?? [] });
      if (path.endsWith(':exportExerciseTcx')) {
        const tcx = account.tcx?.[path.replace(':exportExerciseTcx', '')];
        return Response.json(tcx === undefined ? {} : { tcxData: tcx });
      }
      const rollup =
        /^users\/me\/dataTypes\/([^/]+)\/dataPoints:dailyRollUp$/.exec(path);
      if (rollup) {
        const body: {
          range: {
            start: { date: { year: number; month: number; day: number } };
            end: { date: { year: number; month: number; day: number } };
          };
        } = JSON.parse(await request.text());
        const rows = [];
        for (
          let at = Date.parse(isoDate(body.range.start.date));
          at < Date.parse(isoDate(body.range.end.date));
          at += DAY_MS
        ) {
          const date = new Date(at).toISOString().slice(0, 10);
          const total = account.rollups?.[String(rollup[1])]?.(date);
          if (total)
            rows.push({
              civilEndTime: {
                date: civilDate(
                  new Date(at + DAY_MS).toISOString().slice(0, 10),
                ),
                time: {},
              },
              civilStartTime: { date: civilDate(date), time: {} },
              ...total,
            });
        }
        return Response.json(rows.length ? { rollupDataPoints: rows } : {});
      }
      const list = /^users\/me\/dataTypes\/([^/]+)\/dataPoints$/.exec(path);
      if (!list) return new Response(null, { status: 404 });
      const type = String(list[1]);
      let points = account.points?.[type] ?? [];
      const everyDay = account.everyDay?.[type];
      if (everyDay) {
        const since = /\.date >= "(\d{4}-\d\d-\d\d)"/.exec(
          url.searchParams.get('filter') ?? '',
        )?.[1];
        // Without a start, Google keeps answering dates; ten stand for them.
        const from = Date.parse(since ?? '2026-09-21');
        points = [];
        for (let at = Date.parse('2026-10-15'); at >= from; at -= DAY_MS)
          points.push(everyDay(new Date(at).toISOString().slice(0, 10)));
      }
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const page = points.slice(offset, offset + 2);
      if (page.length === 0) return Response.json({});
      return Response.json({
        dataPoints: page,
        ...(offset + 2 < points.length && {
          nextPageToken: String(offset + 2),
        }),
      });
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
  return { requests, [Symbol.dispose]: () => server.close() };
}

// Loads every stream the source offers into its own table, overwriting it.
async function load(
  warehouse: Pick<Warehouse, 'history' | 'destination' | 'checkpoints'>,
  source = new GoogleHealthSource({ requester: signedIn() }),
) {
  const { streams } = await source.discover();
  await new Pipeline({
    history: warehouse.history,
    connections: [
      new Connection({
        name: 'google-health',
        source,
        destination: warehouse.destination,
        checkpoints: warehouse.checkpoints,
        steps: streams.map(
          (stream) =>
            new Copy(stream, warehouse.destination.table(stream.name), {
              id: stream.name,
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            }),
        ),
      }),
    ],
  }).run();
}

async function rows(warehouse: Warehouse, table: string, order = '1') {
  return warehouse.sql.unsafe(`SELECT * FROM "${table}" ORDER BY ${order}`);
}

const profile = {
  name: 'users/me/profile',
  membershipStartDate: { year: 2026, month: 10, day: 12 },
};

const fitbit = {
  device: { displayName: 'Air', formFactor: 'FITNESS_BAND' },
  platform: 'FITBIT',
  recordingMethod: 'PASSIVELY_MEASURED',
};

function exercise(id: string, displayName: string) {
  return {
    dataSource: fitbit,
    exercise: {
      activeDuration: '1800s',
      createTime: '2026-10-14T08:00:05.123456Z',
      displayName,
      exerciseEvents: [
        {
          eventTime: '2026-10-14T07:00:00Z',
          eventUtcOffset: '10800s',
          exerciseEventType: 'START',
        },
      ],
      exerciseType: 'WALKING',
      interval: {
        endTime: '2026-10-14T07:30:00Z',
        endUtcOffset: '10800s',
        startTime: '2026-10-14T07:00:00Z',
        startUtcOffset: '10800s',
      },
      metricsSummary: { caloriesKcal: 150.5, steps: '3000' },
      splits: [
        {
          endTime: '2026-10-14T07:15:00Z',
          endUtcOffset: '10800s',
          metricsSummary: { steps: '1500' },
          splitType: 'DISTANCE',
          startTime: '2026-10-14T07:00:00Z',
          startUtcOffset: '10800s',
        },
      ],
      updateTime: '2026-10-14T08:00:05.123456Z',
    },
    name: `users/1/dataTypes/exercise/dataPoints/${id}`,
  };
}

function sleepPoint(stageType: string) {
  return {
    dataSource: fitbit,
    name: 'users/1/dataTypes/sleep/dataPoints/s1',
    sleep: {
      interval: {
        endTime: '2026-10-14T04:00:00Z',
        endUtcOffset: '10800s',
        startTime: '2026-10-13T20:00:00Z',
        startUtcOffset: '10800s',
      },
      stages: [
        {
          endTime: '2026-10-13T21:00:00Z',
          endUtcOffset: '10800s',
          startTime: '2026-10-13T20:00:00Z',
          startUtcOffset: '10800s',
          type: stageType,
        },
      ],
      summary: {
        minutesAsleep: '420',
        stagesSummary: [{ count: '3', minutes: '90', type: 'DEEP' }],
      },
      type: 'STAGES',
    },
  };
}

test('every stream loads into a table of its own, and a type the account has no data for loads an empty one', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  using _google = google({ profile });
  const source = new GoogleHealthSource({ requester: signedIn() });
  const { streams } = await source.discover();

  await load(warehouse, source);

  const tables = await warehouse.sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${RAW} AND table_name NOT LIKE '\\_elt%'`;
  assert.deepEqual(
    tables.map(({ table_name }) => table_name).sort(),
    streams.map(({ name }) => name).sort(),
  );
  // Every data type Google lets a user read has a stream, as do the child
  // lists, the rollup-only types and the account.
  assert.equal(streams.length, 56);
  // Google keeps no change record, so the source offers only full refreshes,
  // which is why every test here loads with overwrite.
  assert.ok(
    streams.every(
      ({ supportedSyncModes }) =>
        supportedSyncModes.length === 1 &&
        supportedSyncModes[0] === 'full_refresh',
    ),
  );
  assert.deepEqual([...(await rows(warehouse, 'bloodGlucose'))], []);
});

test('a point deleted or changed upstream is gone or changed after the next run, with its child lists', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  const account: Account = {
    devices: [
      {
        deviceType: 'TRACKER',
        deviceVersion: 'Air',
        name: 'users/1/pairedDevices/1',
      },
    ],
    points: {
      exercise: [
        exercise('e2', 'Evening walk'),
        exercise('e1', 'Morning walk'),
      ],
      sleep: [sleepPoint('DEEP')],
      weight: [
        {
          dataSource: { platform: 'FITBIT', recordingMethod: 'MANUAL' },
          name: 'users/1/dataTypes/weight/dataPoints/w1',
          weight: {
            sampleTime: {
              physicalTime: '2026-10-14T06:00:00Z',
              utcOffset: '10800s',
            },
            weightGrams: 80_000,
          },
        },
      ],
    },
    profile,
  };
  {
    using _google = google(account);
    await load(warehouse);
  }

  account.points = {
    exercise: [exercise('e1', 'Morning walk')],
    sleep: [sleepPoint('REM')],
  };
  account.devices = [];
  {
    using _google = google(account);
    await load(warehouse);
  }

  assert.deepEqual(
    (await rows(warehouse, 'exercise')).map(({ name, displayName }) => [
      name,
      displayName,
    ]),
    [['users/1/dataTypes/exercise/dataPoints/e1', 'Morning walk']],
  );
  assert.deepEqual(
    (await rows(warehouse, 'exerciseSplits')).map(({ exercise }) => exercise),
    ['users/1/dataTypes/exercise/dataPoints/e1'],
  );
  assert.deepEqual(
    (await rows(warehouse, 'sleepStages')).map(({ sleep, type }) => [
      sleep,
      type,
    ]),
    [['users/1/dataTypes/sleep/dataPoints/s1', 'REM']],
  );
  assert.deepEqual([...(await rows(warehouse, 'weight'))], []);
  assert.deepEqual([...(await rows(warehouse, 'pairedDevices'))], []);
});

test('an Apple Watch point relayed from Apple Health and a Fitbit point at the same instant both load, each with its origin', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  const sampleTime = {
    civilTime: {
      date: { day: 14, month: 10, year: 2026 },
      time: { hours: 10, minutes: 5 },
    },
    physicalTime: '2026-10-14T07:05:00Z',
    utcOffset: '10800s',
  };
  using _google = google({
    points: {
      'heart-rate': [
        {
          dataSource: {
            application: { packageName: 'com.apple.health.BA2BC9B6' },
            device: { manufacturer: 'Apple Inc.' },
            platform: 'HEALTH_KIT',
            recordingMethod: 'PASSIVELY_MEASURED',
          },
          heartRate: { beatsPerMinute: '71', sampleTime },
        },
        { dataSource: fitbit, heartRate: { beatsPerMinute: '72', sampleTime } },
      ],
    },
    profile,
  });

  await load(warehouse);

  assert.deepEqual(
    (await rows(warehouse, 'heartRate', 'platform')).map((row) => [
      row.platform,
      row.deviceManufacturer,
      row.applicationPackageName,
      row.deviceDisplayName,
      row.beatsPerMinute,
    ]),
    [
      ['FITBIT', null, null, 'Air', '72'],
      ['HEALTH_KIT', 'Apple Inc.', 'com.apple.health.BA2BC9B6', null, '71'],
    ],
  );
});

test('a daily type and the rollups start on the day the user joined, and the rollups reach today', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  using _google = google({
    everyDay: {
      'daily-heart-rate-zones': (date) => ({
        dailyHeartRateZones: {
          date: civilDate(date),
          heartRateZones: [
            {
              heartRateZoneType: 'LIGHT',
              maxBeatsPerMinute: '110',
              minBeatsPerMinute: '30',
            },
          ],
        },
        dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
      }),
    },
    profile,
    rollups: { floors: () => ({ floors: { countSum: '4' } }) },
  });
  // A run that crosses midnight still reaches the day it began.
  const today = new Date().toISOString().slice(0, 10);

  await load(warehouse);

  const days = async (table: string) =>
    (
      await warehouse.sql.unsafe(
        `SELECT date::text FROM "${table}" ORDER BY date`,
      )
    ).map(({ date }) => date);
  assert.equal((await days('dailyHeartRateZones'))[0], '2026-10-12');
  assert.equal((await days('dailyHeartRateZoneRanges'))[0], '2026-10-12');
  const floors = await days('floors');
  assert.equal(floors[0], '2026-10-12');
  assert.ok(floors.includes(today), 'floors reach the day the run began');
});

test('an account with no Google Health profile fails the run as a config failure that tells the user how to fix it', async () => {
  await using database = await databases.database();
  const warehouse = {
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  using _google = google({
    profile,
    answer: () =>
      Response.json(
        {
          error: {
            code: 400,
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                domain: 'health.googleapis.com',
                reason: 'ACCOUNT_NOT_LINKED',
              },
            ],
            message: 'The Google account is not linked to a Fitbit account.',
            status: 'FAILED_PRECONDITION',
          },
        },
        { status: 400 },
      ),
  });

  const error = await load(warehouse).then(
    () => assert.fail('the account has no profile'),
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof PipelineError, String(error));
  const failures = error.results[0]?.failures ?? [];
  assert.ok(failures.length > 0);
  assert.ok(failures.every(({ failureType }) => failureType === 'config'));
  assert.match(String(failures[0]?.error), /Google Health app/);
});

test('a measured instant to the microsecond, a session instant to the nanosecond, civil times, offsets and 64-bit counts load exactly', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  const workout = exercise('e1', 'Morning walk');
  // As live on 2026-10-15: an exercise an app wrote, to the nanosecond.
  workout.exercise.interval.startTime = '2026-07-01T15:55:06.688527107Z';
  using _google = google({
    points: {
      exercise: [workout],
      steps: [
        {
          dataSource: fitbit,
          steps: {
            count: '9007199254740993',
            interval: {
              civilEndTime: {
                date: { day: 14, month: 10, year: 2026 },
                time: { hours: 10, minutes: 1 },
              },
              civilStartTime: {
                date: { day: 14, month: 10, year: 2026 },
                time: { hours: 10, nanos: 24_575_000, seconds: 40 },
              },
              endTime: '2026-10-14T07:01:00Z',
              endUtcOffset: '10800s',
              startTime: '2026-10-14T07:00:40.024575Z',
              startUtcOffset: '-12600s',
            },
          },
        },
      ],
    },
    profile,
  });

  await load(warehouse);

  const [step] = await warehouse.sql`
    SELECT count::text,
      ("startTime" AT TIME ZONE 'UTC')::text AS "startTime",
      ("endTime" AT TIME ZONE 'UTC')::text AS "endTime",
      "civilStartTime"::text, "startUtcOffsetSeconds"::int
    FROM steps`;
  assert.deepEqual(
    { ...step },
    {
      civilStartTime: '2026-10-14 10:00:40.024575',
      count: '9007199254740993',
      endTime: '2026-10-14 07:01:00',
      startTime: '2026-10-14 07:00:40.024575',
      startUtcOffsetSeconds: -12600,
    },
  );
  const [walk] = await rows(warehouse, 'exercise');
  assert.equal(walk?.startTime, '2026-07-01T15:55:06.688527107Z');
});

test('a stream whose read fails keeps the rows its last run loaded, while the other streams load', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  const account: Account = {
    points: {
      'heart-rate': [
        {
          dataSource: fitbit,
          heartRate: {
            beatsPerMinute: '72',
            sampleTime: { physicalTime: '2026-10-14T07:05:00Z' },
          },
        },
        {
          dataSource: fitbit,
          heartRate: {
            beatsPerMinute: '70',
            sampleTime: { physicalTime: '2026-10-14T07:04:00Z' },
          },
        },
        {
          dataSource: fitbit,
          heartRate: {
            beatsPerMinute: '68',
            sampleTime: { physicalTime: '2026-10-14T07:03:00Z' },
          },
        },
      ],
      steps: [
        {
          dataSource: fitbit,
          steps: {
            count: '1',
            interval: { startTime: '2026-10-14T07:00:00Z' },
          },
        },
      ],
    },
    profile,
  };
  {
    using _google = google(account);
    await load(warehouse);
  }

  account.points = {
    ...account.points,
    steps: [
      {
        dataSource: fitbit,
        steps: { count: '2', interval: { startTime: '2026-10-14T07:00:00Z' } },
      },
    ],
  };
  // The second page of heart rate never comes back.
  account.answer = (url) =>
    url.pathname.endsWith('/heart-rate/dataPoints') &&
    url.searchParams.get('pageToken') === '2'
      ? Response.json(
          {
            error: {
              code: 400,
              message: 'Invalid page token.',
              status: 'INVALID_ARGUMENT',
            },
          },
          { status: 400 },
        )
      : undefined;
  using _google = google(account);
  const error = await load(warehouse).then(
    () => assert.fail('heart rate failed'),
    (failure: unknown) => failure,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    (await rows(warehouse, 'heartRate', '"sampleTime"')).map(
      ({ beatsPerMinute }) => beatsPerMinute,
    ),
    ['68', '70', '72'],
  );
  assert.deepEqual(
    (await rows(warehouse, 'steps')).map(({ count }) => count),
    ['2'],
  );
});

test("each exercise's TCX export loads beside it, and an exercise Google keeps none for loads null", async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  const tcx = '<?xml version="1.0"?><TrainingCenterDatabase/>';
  using _google = google({
    points: {
      exercise: [
        exercise('e2', 'Evening walk'),
        exercise('e1', 'Morning walk'),
      ],
    },
    profile,
    tcx: { 'users/1/dataTypes/exercise/dataPoints/e1': tcx },
  });

  await load(warehouse);

  assert.deepEqual(
    (await rows(warehouse, 'exerciseRoutes', 'exercise')).map(
      ({ exercise, tcx }) => [exercise, tcx],
    ),
    [
      ['users/1/dataTypes/exercise/dataPoints/e1', tcx],
      ['users/1/dataTypes/exercise/dataPoints/e2', null],
    ],
  );
});

test(
  'watching wakes every stream when a device syncs, and none while nothing moved',
  { timeout: 10_000 },
  async () => {
    const devices = [
      { lastSyncTime: '2026-10-15T08:00:00Z', name: 'users/1/pairedDevices/1' },
    ];
    using _google = google({ devices, profile });
    const source = new GoogleHealthSource({
      requester: signedIn(),
      pollIntervalMs: 1,
    });
    const { streams } = await source.discover();
    const controller = new AbortController();

    const woken: number[] = [];
    try {
      for await (const wake of source.watch({
        signal: controller.signal,
        streams,
      })) {
        woken.push(wake.length);
        if (woken.length === 2)
          devices[0] = {
            lastSyncTime: '2026-10-15T09:00:00Z',
            name: 'users/1/pairedDevices/1',
          };
        if (woken.length === 3) break;
      }
    } finally {
      controller.abort();
    }

    assert.deepEqual(woken, [streams.length, 0, streams.length]);
  },
);

test('a value Google could not compute, which it sends as the string NaN, loads as null beside the values it did compute', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  // As live on 2026-10-15: a night before the baseline exists.
  using _google = google({
    points: {
      'daily-sleep-temperature-derivations': [
        {
          dailySleepTemperatureDerivations: {
            baselineTemperatureCelsius: 'NaN',
            date: { day: 14, month: 10, year: 2026 },
            nightlyTemperatureCelsius: 34.21,
            relativeNightlyStddev30dCelsius: 'NaN',
          },
          dataSource: { platform: 'FITBIT', recordingMethod: 'DERIVED' },
        },
      ],
    },
    profile,
  });

  await load(warehouse);

  const [night] = await rows(warehouse, 'dailySleepTemperatureDerivations');
  assert.deepEqual(
    [
      night?.nightlyTemperatureCelsius,
      night?.baselineTemperatureCelsius,
      night?.relativeNightlyStddev30dCelsius,
    ],
    [34.21, null, null],
  );
});

test('a child list comes from the same read as its parent, though Google answers every read anew', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const warehouse = {
    sql: clients.adopt(
      postgres(database.connectionString, {
        max: 1,
        onnotice: () => {},
        connection: { search_path: RAW },
      }),
      (sql) => sql.end(),
    ),
    history: new PostgresSyncHistory({ url: database.connectionString }),
    destination: new PostgresDestination({
      url: database.connectionString,
      schema: RAW,
    }),
    checkpoints: new PostgresCheckpointStore({
      url: database.connectionString,
      schema: RAW,
    }),
  };
  await warehouse.history.install();
  // Each read of sleep gets a different night: a child stream that read on
  // its own would describe another night than its parent's row.
  const nights = [
    { minutesAsleep: '420', stage: 'DEEP' },
    { minutesAsleep: '480', stage: 'REM' },
  ];
  let reads = 0;
  using _google = google({
    answer: (url) => {
      if (!url.pathname.endsWith('/dataTypes/sleep/dataPoints'))
        return undefined;
      const night = nights[Math.min(reads++, 1)];
      const point = sleepPoint(night?.stage ?? 'DEEP');
      return Response.json({
        dataPoints: [
          {
            ...point,
            sleep: {
              ...point.sleep,
              summary: {
                ...point.sleep.summary,
                minutesAsleep: night?.minutesAsleep,
              },
            },
          },
        ],
      });
    },
    profile,
  });

  await load(warehouse);

  const [night] = await rows(warehouse, 'sleep');
  const stages = await rows(warehouse, 'sleepStages');
  assert.deepEqual(
    [night?.summaryMinutesAsleep, stages.map(({ type }) => type)],
    ['420', ['DEEP']],
  );
});
