import {
  type Check,
  Collector,
  Future,
  type Gauge,
  Period,
  type Sample,
} from '@zukhruf/async';

import type {
  SqlServerDatabase,
  SqlServerSession,
} from '@eltjs/sdk-microsoft-sql-server';

// A value of each table, by its quoted name, from one query, which a check
// that times out cancels on the server.
class TableValues extends Collector<string> {
  readonly #read: (signal: AbortSignal) => Promise<ReadonlyMap<string, string>>;

  constructor(
    read: (signal: AbortSignal) => Promise<ReadonlyMap<string, string>>,
  ) {
    super();
    this.#read = read;
  }

  protected collect(check: Check) {
    return this.#read(check.signal);
  }
}

type Version = 'changeTracking' | 'rowversion';

// The two versions of the database, from one query.
class DatabaseVersion extends Collector<Version> {
  readonly #session: WatchSession;

  constructor(session: WatchSession) {
    super();
    this.#session = session;
  }

  protected async collect() {
    const { changeTracking, rowversion } = await (
      await this.#session.open()
    ).version();
    return new Map<Version, Sample>([
      ['changeTracking', changeTracking],
      ['rowversion', rowversion],
    ]);
  }
}

// The gauges of one watch, over one session that the first read that needs it
// opens, so a refused login fails the gauges of that check, not the watch. A
// collector reads in a check only when a watched stream names one of its
// gauges.
export class WatchGauges implements AsyncDisposable {
  // The statistics of each table: SQL Server counts the rows that an insert,
  // a delete, a TRUNCATE or an update of a column with statistics changes,
  // and keeps the count through a restart. An update of a column with no
  // statistics moves nothing.
  readonly statistics: Collector<string>;
  // How many rows each table holds: an insert, a delete or a TRUNCATE moves
  // it, also in a table whose statistics SQL Server has not built yet, which
  // count nothing, and in a tracked table, whose Change Tracking version a
  // TRUNCATE does not move. An update moves nothing.
  readonly rowCounts: Collector<string>;
  // When SQL Server last wrote to each table: any insert, update or delete
  // moves it, also of a column with no statistics.
  readonly lastWrites: Collector<string>;
  // The database's last committed Change Tracking version: each change to a
  // tracked table moves it, in the transaction of the change. A TRUNCATE
  // does not.
  readonly changeTracking: Gauge;
  // The database's last rowversion (@@DBTS): each insert or update of a row
  // with a rowversion column moves it.
  readonly rowversion: Gauge;
  // The whole hours since the watch started: a stream that names it reloads
  // once an hour, which finds a change that its other gauges cannot see.
  readonly hour = new Period(60 * 60_000);
  readonly #session: WatchSession;

  constructor(database: SqlServerDatabase) {
    const session = new WatchSession(database);
    this.#session = session;
    this.statistics = new TableValues(async (signal) =>
      (await session.open()).statistics({ signal }),
    );
    this.rowCounts = new TableValues(async (signal) =>
      (await session.open()).rowCounts({ signal }),
    );
    this.lastWrites = new TableValues(async (signal) =>
      (await session.open()).lastWrites({ signal }),
    );
    const version = new DatabaseVersion(session);
    this.changeTracking = version.gauge('changeTracking');
    this.rowversion = version.gauge('rowversion');
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.#session[Symbol.asyncDispose]();
  }
}

// The session of one watch. An open that fails, for example because the
// server cannot be reached now, leaves it closed, so the next check opens it
// again.
class WatchSession implements AsyncDisposable {
  readonly #database: SqlServerDatabase;
  #state: SessionState;

  constructor(database: SqlServerDatabase) {
    this.#database = database;
    this.#state = new Closed(database);
  }

  // The reads of one check share one open.
  open(): Promise<SqlServerSession> {
    const state = this.#state.open(() => {
      if (this.#state === state) this.#state = new Closed(this.#database);
    });
    this.#state = state;
    return state.session();
  }

  // Each stream's gauge of the watch closes the session when the pipeline
  // disposes it: the first one closes it, and the others find it closed.
  async [Symbol.asyncDispose](): Promise<void> {
    const state = this.#state;
    this.#state = new Closed(this.#database);
    await state[Symbol.asyncDispose]();
  }
}

interface SessionState extends AsyncDisposable {
  // failed runs when the open fails.
  open(failed: () => void): Opening;
}

class Closed implements SessionState {
  readonly #database: SqlServerDatabase;

  constructor(database: SqlServerDatabase) {
    this.#database = database;
  }

  open(failed: () => void): Opening {
    return new Opening(this.#database, failed);
  }

  // Nothing is open.
  async [Symbol.asyncDispose](): Promise<void> {}
}

class Opening implements SessionState {
  readonly #opened: Future<SqlServerSession>;

  constructor(database: SqlServerDatabase, failed: () => void) {
    this.#opened = Future.run(async () => {
      try {
        return await database.open();
      } catch (error) {
        failed();
        throw error;
      }
    });
  }

  open(): Opening {
    return this;
  }

  session(): Promise<SqlServerSession> {
    return this.#opened.wait();
  }

  // An open that failed has nothing to close; its gauges gave its error.
  async [Symbol.asyncDispose](): Promise<void> {
    const session = await this.#opened.wait().catch(() => undefined);
    await session?.[Symbol.asyncDispose]();
  }
}
