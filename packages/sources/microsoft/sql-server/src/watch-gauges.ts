import { Collector, type Gauge, Period, type Sample } from '@zukhruf/async';

import type { SqlServerSession } from '@workspace/sdk-microsoft-sql-server';

// A value of each table, by its quoted name, from one query.
class TableValues extends Collector<string> {
  readonly #read: () => Promise<ReadonlyMap<string, string>>;

  constructor(read: () => Promise<ReadonlyMap<string, string>>) {
    super();
    this.#read = read;
  }

  protected collect() {
    return this.#read();
  }
}

type Version = 'changeTracking' | 'rowversion';

// The two versions of the database, from one query.
class DatabaseVersion extends Collector<Version> {
  readonly #session: SqlServerSession;

  constructor(session: SqlServerSession) {
    super();
    this.#session = session;
  }

  protected async collect() {
    const { changeTracking, rowversion } = await this.#session.version();
    return new Map<Version, Sample>([
      ['changeTracking', changeTracking],
      ['rowversion', rowversion],
    ]);
  }
}

// The gauges of one watch, over the session that the watch opens, so none
// outlives the watch. A collector reads in a check only when a watched
// stream names one of its gauges.
export class WatchGauges {
  // The statistics of each table: SQL Server counts the rows that an insert,
  // a delete, a TRUNCATE or an update of a column with statistics changes,
  // and keeps the count through a restart. An update of a column with no
  // statistics moves nothing.
  readonly statistics: Collector<string>;
  // How many rows each table holds: an insert, a delete or a TRUNCATE moves
  // it, also in a table whose statistics SQL Server has not built yet, which
  // count nothing. An update moves nothing.
  readonly rowCounts: Collector<string>;
  // When SQL Server last wrote to each table: any insert, update or delete
  // moves it, also of a column with no statistics.
  readonly lastWrites: Collector<string>;
  // The database's last committed Change Tracking version: each change to a
  // tracked table moves it, in the transaction of the change.
  readonly changeTracking: Gauge;
  // The database's last rowversion (@@DBTS): each insert or update of a row
  // with a rowversion column moves it.
  readonly rowversion: Gauge;
  // The whole hours since the watch started: a stream that names it reloads
  // once an hour, which finds a change that its other gauges cannot see.
  readonly hour = new Period(60 * 60_000);

  constructor(session: SqlServerSession) {
    this.statistics = new TableValues(() => session.statistics());
    this.rowCounts = new TableValues(() => session.rowCounts());
    this.lastWrites = new TableValues(() => session.lastWrites());
    const version = new DatabaseVersion(session);
    this.changeTracking = version.gauge('changeTracking');
    this.rowversion = version.gauge('rowversion');
  }
}
