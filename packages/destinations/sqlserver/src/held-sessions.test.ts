import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { inspect } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';
import { waitFor } from '@zukhruf/testing/async';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  Pipeline,
  type PipelineClock,
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';
import {
  type SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  SqlServerCheckpointStore,
  SqlServerDestination,
  type SqlServerLogin,
  SqlServerSyncHistory,
} from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

const emulation = await SqlServer.emulation({ environment: process.env });

// A database of its own for one test, which keeps row versions, as the
// destination needs. The admin reads the sessions of the pass and kills them.
async function scratch() {
  const database = await sqlServer.database();
  const login: SqlServerLogin = {
    server: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    trustServerCertificate: true,
  };
  const admin = await new SqlServerDatabase(login).connect(globalThis);
  await admin.query(
    `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
  );
  return {
    login,
    admin,
    async [Symbol.asyncDispose]() {
      await admin[Symbol.asyncDispose]();
      await database[Symbol.asyncDispose]();
    },
  };
}

class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// A wait the test ends, and a promise that settles once the read reached it.
function latch() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    release: () => released.resolve(),
    step: async () => {
      reached.resolve();
      await released.promise;
    },
  };
}

// One note, read after a wait.
class Waiting extends Source {
  readonly identity = 'waiting';
  readonly stream = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: { n: { type: 'integer', description: 'The note.' } },
      required: ['n'],
    },
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  protected readonly catalog = new Catalog([this.stream]);
  readonly #wait: () => Promise<void>;

  constructor(wait: () => Promise<void>) {
    super();
    this.#wait = wait;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async *extract(
    configuration: CopyConfiguration,
  ): AsyncIterable<SourceMessage> {
    await this.#wait();
    yield { stream: configuration.stream.name, data: { n: 1 } };
    yield {
      type: 'STATE',
      stream: configuration.stream.name,
      state: { after: 1 },
    };
  }
}

// A pass of one copy of the notes into marts.notes: an incremental copy
// keeps its checkpoint in the database.
function pass(
  login: SqlServerLogin,
  source: Waiting,
  clock: PipelineClock,
  syncMode: 'full_refresh' | 'incremental',
) {
  const destination = new SqlServerDestination({ login });
  return new Pipeline({
    clock,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        ...(syncMode === 'incremental'
          ? { checkpoints: new SqlServerCheckpointStore({ login }) }
          : {}),
        steps: [
          new Copy(source.stream, destination.table('notes'), {
            id: 'notes:notes',
            syncMode,
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  }).run();
}

// Each other session of the database: when its last statement ended, and
// how many application locks it holds.
async function sessions(admin: SqlServerConnection) {
  const rows = await admin.query(
    `SELECT s.session_id AS spid, s.last_request_end_time AS ended,
       (SELECT COUNT(*) FROM sys.dm_tran_locks AS l WHERE l.request_session_id = s.session_id AND l.resource_type = N'APPLICATION') AS locks
     FROM sys.dm_exec_sessions AS s
     WHERE s.database_id = DB_ID() AND s.is_user_process = 1 AND s.session_id <> @@SPID
     ORDER BY s.session_id`,
  );
  return rows.map(({ spid, ended, locks }) => {
    assert.ok(ended instanceof Date);
    return { spid: Number(spid), ended: ended.getTime(), locks: Number(locks) };
  });
}

test(
  'while the stream of a pass waits, a minute on the clock of the pipeline runs a statement on the session of its load',
  { skip: emulation },
  async (t) => {
    await using database = await scratch();
    const wait = latch();
    const source = new Waiting(wait.step);
    const clock = createClock(Date.now());
    const passing = pass(database.login, source, clock, 'full_refresh');
    await wait.reached;

    let before;
    try {
      before = await sessions(database.admin);
      // The history holds the lock of the attempt; the load holds none.
      const load = before.find(({ locks }) => locks === 0);
      await clock.tickAsync(60_000);
      // The statement reaches the server in real time once the clock moved,
      // less than a real minute after the last statement of the load, so no
      // timer of real time ran it.
      await waitFor(
        async () => {
          const now = (await sessions(database.admin)).find(
            ({ spid }) => spid === load?.spid,
          );
          assert.ok(load !== undefined && now !== undefined);
          assert.ok(
            now.ended > load.ended && now.ended < load.ended + 60_000,
            inspect({ load, now }),
          );
        },
        { signal: t.signal },
      );
    } finally {
      wait.release();
      await passing;
    }

    assert.deepEqual(
      before.map(({ locks }) => locks).toSorted(),
      [0, 1],
      inspect(before),
    );
  },
);

test(
  'every session that a pass holds runs a statement in each minute that its stream waits, and none ends',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const wait = latch();
    const source = new Waiting(wait.step);
    const passing = pass(database.login, source, globalThis, 'incremental');
    await wait.reached;

    let before;
    let after;
    try {
      before = await sessions(database.admin);
      await setTimeout(65_000);
      after = await sessions(database.admin);
    } finally {
      wait.release();
      await passing;
    }

    // The history holds the lock of the attempt; the checkpoints, the load
    // and the pool that renews the lease of the checkpoint hold none.
    assert.deepEqual(
      before.map(({ locks }) => locks).toSorted(),
      [0, 0, 0, 1],
      inspect(before),
    );
    assert.deepEqual(
      after.map(({ spid }) => spid),
      before.map(({ spid }) => spid),
    );
    for (const [index, { spid, ended }] of before.entries())
      assert.ok(
        (after[index]?.ended ?? 0) > ended,
        `session ${spid} ran nothing during the wait`,
      );
  },
);

test(
  'a pass whose history session the server ends while the stream waits records its outcome on a session of its own, and its run gives its result',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const wait = latch();
    const source = new Waiting(wait.step);
    const passing = pass(database.login, source, globalThis, 'full_refresh');
    await wait.reached;

    try {
      const history = (await sessions(database.admin)).find(
        ({ locks }) => locks === 1,
      );
      await database.admin.query(`KILL ${Number(history?.spid)}`);
    } finally {
      wait.release();
    }
    const results = await passing;

    assert.deepEqual(
      results.map(({ count }) => count),
      [1],
    );
    assert.deepEqual(
      await database.admin.query(
        'SELECT a.status, a.error, c.status AS stream, c.written_count AS written FROM marts.sync_attempts AS a JOIN marts.extraction_coverage AS c ON c.attempt_id = a.attempt_id',
      ),
      [{ status: 'succeeded', error: null, stream: 'succeeded', written: '1' }],
    );
  },
);

test(
  'a pass whose history session the server ends while it records the outcome records it again on a session of its own',
  { skip: emulation },
  async (t) => {
    await using database = await scratch();
    const wait = latch();
    const source = new Waiting(wait.step);
    const passing = pass(database.login, source, globalThis, 'full_refresh');
    await wait.reached;

    await using holder = await new SqlServerDatabase(database.login).connect(
      globalThis,
    );
    try {
      const history = (await sessions(database.admin)).find(
        ({ locks }) => locks === 1,
      );
      const [locking] = await holder.query('SELECT @@SPID AS spid');
      // The record of the outcome waits for the rows that holder locks.
      await holder.query(
        'BEGIN TRANSACTION; SELECT COUNT(*) AS [rows] FROM _warehouse.extraction_coverage WITH (UPDLOCK, HOLDLOCK)',
      );
      wait.release();
      await waitFor(
        async () => {
          const [blocked] = await database.admin.query(
            'SELECT COUNT(*) AS [waits] FROM sys.dm_exec_requests WHERE session_id = CAST(@spid AS int) AND blocking_session_id = CAST(@holder AS int)',
            { spid: String(history?.spid), holder: String(locking?.spid) },
          );
          assert.equal(blocked?.waits, 1);
        },
        { signal: t.signal },
      );
      await database.admin.query(`KILL ${Number(history?.spid)}`);
    } finally {
      wait.release();
      await holder.query('IF @@TRANCOUNT > 0 COMMIT');
    }
    const results = await passing;

    assert.deepEqual(
      results.map(({ count }) => count),
      [1],
    );
    assert.deepEqual(
      await database.admin.query(
        'SELECT a.status, a.error, c.status AS stream FROM marts.sync_attempts AS a JOIN marts.extraction_coverage AS c ON c.attempt_id = a.attempt_id',
      ),
      [{ status: 'succeeded', error: null, stream: 'succeeded' }],
    );
  },
);

test(
  'a pass whose load session the server ends while the stream waits fails with an error that says so, and its attempt is recorded as failed',
  { skip: emulation },
  async () => {
    await using database = await scratch();
    const wait = latch();
    const source = new Waiting(wait.step);
    const passing = pass(database.login, source, globalThis, 'full_refresh');
    await wait.reached;

    try {
      const load = (await sessions(database.admin)).find(
        ({ locks }) => locks === 0,
      );
      await database.admin.query(`KILL ${Number(load?.spid)}`);
    } finally {
      wait.release();
    }
    const failed = await passing.then(
      () => assert.fail('the pass loaded'),
      (error: unknown) => error,
    );

    assert.ok(failed instanceof PipelineError, inspect(failed));
    assert.match(inspect(failed), /The session of this connection ended/);
    const [attempt, ...others] = await database.admin.query(
      'SELECT status, error FROM marts.sync_attempts',
    );
    assert.deepEqual(others, []);
    assert.equal(attempt?.status, 'failed');
    assert.match(
      String(attempt?.error),
      /notes: SQL Server .+ cannot be reached\./,
    );
  },
);
