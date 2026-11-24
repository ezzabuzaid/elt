import {
  type Check,
  Collector,
  Future,
  type Gauge,
  Period,
  type Sample,
  untilAborted,
} from '@zukhruf/async';

import type { PipelineClock } from '@eltjs/elt';
import type {
  SqlServerDatabase,
  SqlServerSession,
} from '@eltjs/sdk-microsoft-sql-server';

// What a read of a check waits on: the login of the session, or one query.
type Phase = 'open' | TableQuery | 'version';

type TableQuery = 'statistics' | 'rowCounts' | 'lastWrites';

// A value of each table, by its quoted name, from one query, which a check
// that times out cancels on the server.
class TableValues extends Collector<string> {
  readonly #session: WatchSession;
  readonly #query: TableQuery;

  constructor(session: WatchSession, query: TableQuery) {
    super();
    this.#session = session;
    this.#query = query;
  }

  protected async collect(check: Check) {
    const session = await this.#session.open(check);
    return this.#session.during(
      this.#query,
      check,
      session[this.#query]({ signal: check.signal }),
    );
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

  protected async collect(check: Check) {
    const session = await this.#session.open(check);
    const { changeTracking, rowversion } = await this.#session.during(
      'version',
      check,
      session.version(),
    );
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

  constructor(database: SqlServerDatabase, clock: PipelineClock) {
    const session = new WatchSession(database, clock);
    this.#session = session;
    this.statistics = new TableValues(session, 'statistics');
    this.rowCounts = new TableValues(session, 'rowCounts');
    this.lastWrites = new TableValues(session, 'lastWrites');
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
  readonly #clock: PipelineClock;
  #state: SessionState;

  constructor(database: SqlServerDatabase, clock: PipelineClock) {
    this.#database = database;
    this.#clock = clock;
    this.#state = new Closed(database);
  }

  // The reads of one check share one open.
  open(check: Check): Promise<SqlServerSession> {
    const state = this.#state.open(() => {
      if (this.#state === state) this.#state = new Closed(this.#database);
    });
    this.#state = state;
    return this.during('open', check, state.session());
  }

  // Settles like work, or fails at the abort of the check with an error that
  // names the phase and its time, with the reason of the signal as its cause.
  // A check records its own error only for a read that fails in the turn of
  // the abort (ADR 0019 of @zukhruf/async), so it fails from the abort
  // listener, not when the server confirms the cancel. The work goes on, and
  // a cancelled query frees its connection for the next check (ADR 0007).
  async during<T>(phase: Phase, check: Check, work: Promise<T>): Promise<T> {
    const started = this.#clock.Date.now();
    try {
      return await untilAborted(work, check.signal);
    } catch (error) {
      if (!check.signal.aborted || error !== check.signal.reason) throw error;
      throw new Error(
        `timed out in ${phase} after ${this.#clock.Date.now() - started} ms`,
        { cause: error },
      );
    }
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
  // What a dispose closes: the session, or nothing once the open failed, as
  // its gauges gave its error.
  readonly #closable = new Future<SqlServerSession | undefined>();

  constructor(database: SqlServerDatabase, failed: () => void) {
    this.#opened = Future.run(async () => {
      try {
        const session = await database.open();
        this.#closable.resolve(session);
        return session;
      } catch (error) {
        this.#closable.resolve(undefined);
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

  async [Symbol.asyncDispose](): Promise<void> {
    const session = await this.#closable.wait();
    await session?.[Symbol.asyncDispose]();
  }
}
