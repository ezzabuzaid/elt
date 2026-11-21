import { type NumberedStore, type Numbering, numbering } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { takeLock, transaction } from './sql-server-connection.ts';
import { quote } from './sql-server-identifiers.ts';
import { inWarehouse, warehouse } from './sql-server-schemas.ts';
import { SqlServerSetupError } from './sql-server-setup-error.ts';

// In _warehouse, beside the sync history, so one numbering orders the commits
// of every load of the database.
const epochs = inWarehouse('_elt_epoch');
const loads = inWarehouse('_elt_loads');
const commits = inWarehouse('_elt_commits');

// How the database numbers its commits (ADR 0002). The number of a commit is
// the rowversion of its row in _elt_commits, which the commit inserts before
// it changes a row; no other table of the destination has a rowversion
// column. The epoch names the numbering, and mark names the copy of the
// database that gave it: a restored copy gives numbers again that the
// original gave, so it starts a new epoch. A name of a connection or a
// dataset compares by its code points, as in Postgres.
const tables = `
  IF SCHEMA_ID(N'${warehouse}') IS NULL EXEC (N'CREATE SCHEMA ${quote(warehouse)}');
  IF OBJECT_ID(N'${epochs}', N'U') IS NULL
    CREATE TABLE ${epochs} ([id] int NOT NULL PRIMARY KEY CHECK ([id] = 1), [epoch] nvarchar(36) NOT NULL, [mark] nvarchar(400) NOT NULL, [min_valid] bigint NOT NULL DEFAULT 0, [expired_by] nvarchar(20) NULL CHECK ([expired_by] IN (N'retention', N'type', N'clear')));
  IF OBJECT_ID(N'${loads}', N'U') IS NULL
    CREATE TABLE ${loads} ([id] bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY, [connector] nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL, [dataset] nvarchar(max) COLLATE Latin1_General_100_BIN2 NULL, [opened_at] datetimeoffset(3) NOT NULL, [closed_at] datetimeoffset(3) NULL, CHECK (([connector] IS NULL AND [dataset] IS NOT NULL) OR ([connector] IS NOT NULL AND [dataset] IS NULL)));
  IF OBJECT_ID(N'${commits}', N'U') IS NULL
  BEGIN
    CREATE TABLE ${commits} ([number] rowversion NOT NULL PRIMARY KEY, [load] bigint NOT NULL REFERENCES ${loads} ([id]), [committed_at] datetimeoffset(3) NOT NULL);
    CREATE INDEX [_elt_commits_load] ON ${commits} ([load], [number]);
  END;
  INSERT INTO ${epochs} ([id], [epoch], [mark])
    SELECT 1, CONVERT(nvarchar(36), NEWID()), @mark WHERE NOT EXISTS (SELECT 1 FROM ${epochs});`;

// How a SQL Server database names itself in the reasons of its positions.
export const sqlServerDatabase: NumberedStore = {
  engine: 'SQL Server',
  noun: 'database',
};

// What writes a load: a connection's pass, or a refresh of a derived dataset.
export type LoadOwner =
  { readonly connector: string } | { readonly dataset: string };

function owned(owner: LoadOwner): readonly ['connector' | 'dataset', string] {
  return 'connector' in owner
    ? ['connector', owner.connector]
    : ['dataset', owner.dataset];
}

// Refuses a database that the destination cannot load or read as ADR 0010
// says: an engine older than SQL Server 2025 has no VECTOR and no JSON type,
// and a database that keeps no row versions makes readers wait for a load
// and refuses a SNAPSHOT transaction. Any user of the database can read its
// row of sys.databases. Gives whether the database is an Azure SQL Database.
export async function requireRowVersions(
  connection: SqlServerConnection,
): Promise<{ readonly name: string; readonly azure: boolean }> {
  const [setup] = await connection.query(
    `SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [edition], CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [major],
       CAST([is_read_committed_snapshot_on] AS int) AS [committed_snapshot], CAST([snapshot_isolation_state] AS int) AS [snapshot], DB_NAME() AS [name]
     FROM sys.databases WHERE [database_id] = DB_ID()`,
  );
  const name = String(setup?.name);
  // Azure SQL Database (5) and Managed Instance (8) report version 12 but run
  // the current engine.
  const azure = setup?.edition === 5;
  if (!azure && setup?.edition !== 8 && Number(setup?.major) < 17)
    throw new SqlServerSetupError(
      `Database ${name} runs SQL Server ${String(setup?.major)}; the SQL Server destination needs SQL Server 2025 (17.x), Azure SQL Database or Azure SQL Managed Instance`,
    );
  const statements = [
    ...(setup?.snapshot === 1
      ? []
      : [`ALTER DATABASE ${quote(name)} SET ALLOW_SNAPSHOT_ISOLATION ON`]),
    ...(setup?.committed_snapshot === 1
      ? []
      : [
          `ALTER DATABASE ${quote(name)} SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
        ]),
  ];
  if (statements.length > 0)
    throw new SqlServerSetupError(
      `Database ${name} keeps no row versions for readers, so they would wait for each load; run ${statements.join('; ')}`,
    );
  return { name, azure };
}

// Refuses a database that the destination cannot load, and gives the mark of
// the copy of the database: the recovery fork of SQL Server, which each
// restore changes and a restart does not; Azure SQL Database has no such
// view, so there each value of sys.databases that a restore changes.
export async function databaseCopy(
  connection: SqlServerConnection,
): Promise<string> {
  const { name, azure } = await requireRowVersions(connection);
  const [copy] = await connection.query(
    azure
      ? `SELECT CONCAT([database_id], N' ', CONVERT(nvarchar(30), [create_date], 126), N' ', [physical_database_name]) AS [mark] FROM sys.databases WHERE [database_id] = DB_ID()`
      : 'SELECT CONVERT(nvarchar(36), [recovery_fork_guid]) AS [mark] FROM sys.database_recovery_status WHERE [database_id] = DB_ID()',
  );
  if (typeof copy?.mark !== 'string')
    throw new TypeError(`Database ${name} gave no mark of its copy`);
  return copy.mark;
}

// Makes the numbering if the database has none, under the lock of
// _warehouse, and starts a new epoch when the database is another copy than
// the one that numbered it, such as one restored from a backup. Only one of
// two loads that find a new copy at once changes the epoch.
export async function installNumbering(
  connection: SqlServerConnection,
  mark: string,
): Promise<void> {
  const [made] = await connection.query(
    `SELECT CASE WHEN OBJECT_ID(N'${epochs}', N'U') IS NULL THEN 0 ELSE 1 END AS [made]`,
  );
  if (made?.made !== 1)
    await transaction(connection, async () => {
      await takeLock(connection, warehouse);
      await connection.query(tables, { mark });
    });
  await connection.query(
    `UPDATE ${epochs} SET [epoch] = CONVERT(nvarchar(36), NEWID()), [mark] = @mark WHERE [id] = 1 AND [mark] <> @mark`,
    { mark },
  );
}

// Lets a reader read the positions and the readings of the database with its
// own session: the numbering, and nothing else of _warehouse.
export async function grantReading(
  connection: SqlServerConnection,
  reader: string,
): Promise<void> {
  await connection.query(
    `GRANT SELECT ON ${epochs} TO ${quote(reader)}; GRANT SELECT ON ${commits} TO ${quote(reader)}; GRANT SELECT ON ${loads} TO ${quote(reader)}`,
  );
}

// Records a load of owner that opens at openedAt, and gives its id. A load of
// the same owner that is still open is one whose process ended during it:
// the new load closes it. The UPDATE that closes it reads each row of
// _elt_loads with an update lock, as an nvarchar(max) owner has no index, so
// two opens that each held the row they inserted would wait for each other
// until SQL Server killed one (error 1205). The open takes the lock of
// _elt_loads before it inserts, so two opens run one at a time.
export async function openLoad(
  connection: SqlServerConnection,
  owner: LoadOwner,
  openedAt: Date,
): Promise<string> {
  const [column, name] = owned(owner);
  const [load] = await transaction(connection, async () => {
    await takeLock(connection, `${warehouse}._elt_loads`);
    return connection.query(
      `DECLARE @load table ([id] bigint);
       INSERT INTO ${loads} ([${column}], [opened_at]) OUTPUT inserted.[id] INTO @load VALUES (@name, CAST(@at AS datetimeoffset(3)));
       UPDATE ${loads} SET [closed_at] = CAST(@at AS datetimeoffset(3))
         WHERE [${column}] = @name AND [closed_at] IS NULL AND [id] <> (SELECT [id] FROM @load);
       SELECT CONVERT(nvarchar(20), [id]) AS [id] FROM @load;`,
      { name, at: openedAt.toISOString() },
    );
  });
  if (typeof load?.id !== 'string')
    throw new Error('The load was not recorded');
  return load.id;
}

export async function closeLoad(
  connection: SqlServerConnection,
  load: string,
  closedAt: Date,
): Promise<void> {
  await connection.query(
    `UPDATE ${loads} SET [closed_at] = CAST(@at AS datetimeoffset(3)) WHERE [id] = CAST(@load AS bigint) AND [closed_at] IS NULL`,
    { load, at: closedAt.toISOString() },
  );
}

// Inserts the commit row of a commit of load, as the first write of its
// transaction, and gives its rowversion, the number of the commit. A load
// that a later load of its owner closed has ended, and a commit after its end
// would move a position that readers were already given: the commit holds a
// shared lock on the row of its load, so a close that runs at the same time
// waits for the commit.
export async function commitNumber(
  connection: SqlServerConnection,
  { load, owner }: { load: string; owner: LoadOwner },
  committedAt: Date,
  retention: Temporal.Duration,
): Promise<number> {
  const [open] = await connection.query(
    `SELECT 1 AS [open] FROM ${loads} WITH (HOLDLOCK, ROWLOCK) WHERE [id] = CAST(@load AS bigint) AND [closed_at] IS NULL`,
    { load },
  );
  if (open === undefined)
    throw new Error(
      'connector' in owner
        ? `A later load of connection ${owner.connector} closed this load, so it cannot commit; a connection runs one pass at a time`
        : `A later refresh of dataset ${owner.dataset} closed this one, so it cannot commit; a dataset refreshes one at a time`,
    );
  const [taken] = await connection.query(
    `INSERT INTO ${commits} ([load], [committed_at]) OUTPUT CONVERT(nvarchar(20), CAST(inserted.[number] AS bigint)) AS [number] VALUES (CAST(@load AS bigint), CAST(@at AS datetimeoffset(3)))`,
    { load, at: committedAt.toISOString() },
  );
  if (typeof taken?.number !== 'string')
    throw new Error('No commit number was taken');
  await retain(connection, committedAt, retention);
  return Number(taken.number);
}

// Takes back the commit row of a commit that changed no row, before it
// commits: its number is a gap, as the number of a commit that rolled back
// is, so no reader sees a position that changed nothing.
export async function forgetCommit(
  connection: SqlServerConnection,
  number: number,
): Promise<void> {
  await connection.query(
    `DELETE FROM ${commits} WHERE [number] = CAST(CAST(@number AS bigint) AS binary(8))`,
    { number: String(number) },
  );
}

// Applies the retention inside a commit's transaction, as elt-postgresql
// does: the newest position whose commit is older than the window becomes
// min_valid, and the numbering then keeps no commit before it and no closed
// load left with none. min_valid only moves forward, as commits of other
// connections run at the same time.
async function retain(
  connection: SqlServerConnection,
  at: Date,
  retention: Temporal.Duration,
): Promise<void> {
  const cutoff = new Date(at.getTime() - retention.total('milliseconds'));
  const [row] = await connection.query(
    `SELECT CONVERT(nvarchar(20), (SELECT ISNULL(MAX(CAST([number] AS bigint)), 0) FROM ${commits} WHERE [committed_at] < CAST(@cutoff AS datetimeoffset(3)))) AS [older],
       CONVERT(nvarchar(20), [min_valid]) AS [min_valid]
     FROM ${epochs}`,
    { cutoff: cutoff.toISOString() },
  );
  if (row === undefined) return;
  const older = Number(row.older);
  const kept = Number(row.min_valid);
  if (older <= kept) return;
  const expired = (await numberingIn(connection, older))?.ends.at(-1);
  if (expired === undefined || expired <= kept) return;
  await connection.query(
    `UPDATE ${epochs} SET [min_valid] = CAST(@expired AS bigint), [expired_by] = N'retention' WHERE [min_valid] < CAST(@expired AS bigint);
     IF @@ROWCOUNT > 0
     BEGIN
       DELETE FROM ${commits} WHERE CAST([number] AS bigint) < CAST(@expired AS bigint);
       DELETE FROM ${loads} WHERE [closed_at] IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${commits} AS c WHERE c.[load] = ${loads}.[id]);
     END;`,
    { expired: String(expired) },
  );
}

// The oldest commit that a reading can read as of, inside the transaction
// connection runs in.
export async function minValid(
  connection: SqlServerConnection,
): Promise<number> {
  const [row] = await connection.query(
    `SELECT CONVERT(nvarchar(20), [min_valid]) AS [min_valid] FROM ${epochs}`,
  );
  return Number(row?.min_valid ?? 0);
}

// The number of a change that is a load of one commit, such as a clear,
// taken inside the caller's transaction: the load opens, commits and closes
// in it. It is not a pass, so it leaves the open loads of its connector open.
export async function commitOnce(
  connection: SqlServerConnection,
  connector: string,
  at: Date,
  retention: Temporal.Duration,
): Promise<number> {
  const [load] = await connection.query(
    `INSERT INTO ${loads} ([connector], [opened_at]) OUTPUT CONVERT(nvarchar(20), inserted.[id]) AS [id] VALUES (@connector, CAST(@at AS datetimeoffset(3)))`,
    { connector, at: at.toISOString() },
  );
  if (typeof load?.id !== 'string')
    throw new Error('The load was not recorded');
  const number = await commitNumber(
    connection,
    { load: load.id, owner: { connector } },
    at,
    retention,
  );
  await closeLoad(connection, load.id, at);
  return number;
}

// Makes each position before the commit changedIn expire, inside that
// commit, for by: a change of type that is not a widening, or a clear that
// forgets the rows it removes.
export async function expireBefore(
  connection: SqlServerConnection,
  changedIn: number,
  by: 'type' | 'clear',
): Promise<void> {
  await connection.query(
    `UPDATE ${epochs} SET [min_valid] = CAST(@changed AS bigint), [expired_by] = @by WHERE [min_valid] < CAST(@changed AS bigint)`,
    { changed: String(changedIn), by },
  );
}

// The numbering as the transaction that connection runs in sees it, with
// settled taken before its snapshot.
export async function numberingIn(
  connection: SqlServerConnection,
  settled: number,
): Promise<Numbering | null> {
  const [row] = await connection.query(
    `SELECT [epoch], CONVERT(nvarchar(20), [min_valid]) AS [min_valid], [expired_by] FROM ${epochs}`,
  );
  if (row === undefined) return null;
  const spans = await connection.query(
    `SELECT CONVERT(nvarchar(20), MIN(CAST(c.[number] AS bigint))) AS [first],
       CASE WHEN l.[closed_at] IS NULL THEN NULL ELSE CONVERT(nvarchar(20), MAX(CAST(c.[number] AS bigint))) END AS [last]
     FROM ${commits} AS c JOIN ${loads} AS l ON l.[id] = c.[load]
     GROUP BY l.[id], l.[closed_at]`,
  );
  const { expired_by: expiredBy } = row;
  return numbering({
    epoch: String(row.epoch),
    minValid: Number(row.min_valid),
    expiredBy:
      expiredBy === 'retention' || expiredBy === 'type' || expiredBy === 'clear'
        ? expiredBy
        : null,
    settled,
    spans: spans.map(({ first, last }) => ({
      first: Number(first),
      last: last === null ? null : Number(last),
    })),
  });
}

// The high-water mark: MIN_ACTIVE_ROWVERSION() is the lowest number that a
// transaction still holds, so each number below it is settled, and a
// snapshot that begins after the read sees each commit at or below the mark
// (ADR 0002). Null when the database has no numbering.
export async function settledMark(
  connection: SqlServerConnection,
): Promise<number | null> {
  const [mark] = await connection.query(
    `SELECT CONVERT(nvarchar(20), CAST(MIN_ACTIVE_ROWVERSION() AS bigint) - 1) AS [settled], CASE WHEN OBJECT_ID(N'${epochs}', N'U') IS NULL THEN 0 ELSE 1 END AS [made]`,
  );
  return mark?.made === 1 ? Number(mark.settled) : null;
}

// When the commit number was made, and the newest commit, as the transaction
// that connection runs in sees them; undefined for a number of no commit.
export async function committedAt(
  connection: SqlServerConnection,
  number: number,
): Promise<{ readonly at: Date; readonly newest: number } | undefined> {
  const [row] = await connection.query(
    `SELECT [committed_at] AS [at], (SELECT CONVERT(nvarchar(20), MAX(CAST([number] AS bigint))) FROM ${commits}) AS [newest]
     FROM ${commits} WHERE [number] = CAST(CAST(@number AS bigint) AS binary(8))`,
    { number: String(number) },
  );
  if (row === undefined) return undefined;
  if (!(row.at instanceof Date))
    throw new TypeError(`Commit ${number} gave no time`);
  return { at: row.at, newest: Number(row.newest) };
}

// The numbering in a SNAPSHOT transaction of its own, with the high-water
// mark read before it. connection is a session of its own, which keeps the
// SNAPSHOT isolation level after.
export async function readNumbering(
  connection: SqlServerConnection,
): Promise<Numbering | null> {
  const settled = await settledMark(connection);
  if (settled === null) return null;
  await connection.query(
    'SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRANSACTION',
  );
  try {
    return await numberingIn(connection, settled);
  } finally {
    await connection.query('COMMIT');
  }
}
