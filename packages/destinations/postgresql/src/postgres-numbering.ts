import type postgres from 'postgres';

import { schemaLock } from './postgres-session.ts';

// A session, or a transaction of one.
type Queries = postgres.Sql | postgres.TransactionSql;

// The schema that every destination of the database shares, beside the sync
// history, so one numbering orders the commits of all its schemas.
const shared = '_warehouse';
const epochs = `${shared}."_elt_epoch"`;
const loads = `${shared}."_elt_loads"`;
const commits = `${shared}."_elt_commits"`;
const numbers = `${shared}."_elt_commit_numbers"`;

// How the database numbers its commits. The epoch names the numbering: it is
// made with the tables, so a database made again starts a numbering of its
// own. min_valid is the oldest commit that a reading can read as of: a
// change of the type of a column that is not a widening expires each
// position before its commit. A number is an integer, so the sequence fails
// at its end rather than wrap to a number that names another commit.
const tables = [
  `CREATE SCHEMA IF NOT EXISTS ${shared}`,
  `CREATE TABLE IF NOT EXISTS ${epochs} ("id" integer PRIMARY KEY CHECK ("id" = 1), "epoch" text NOT NULL, "min_valid" integer NOT NULL DEFAULT 0, "expired_by" text CHECK ("expired_by" IN ('retention', 'type')))`,
  `CREATE TABLE IF NOT EXISTS ${loads} ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "connector" text NOT NULL, "opened_at" timestamptz NOT NULL, "closed_at" timestamptz)`,
  `CREATE INDEX IF NOT EXISTS "_elt_loads_open" ON ${loads} ("connector") WHERE "closed_at" IS NULL`,
  `CREATE SEQUENCE IF NOT EXISTS ${numbers} AS integer`,
  `CREATE TABLE IF NOT EXISTS ${commits} ("number" integer PRIMARY KEY, "load" bigint NOT NULL REFERENCES ${loads} ("id"), "committed_at" timestamptz NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS "_elt_commits_load" ON ${commits} ("load", "number")`,
  `INSERT INTO ${epochs} ("id", "epoch") VALUES (1, gen_random_uuid()::text) ON CONFLICT DO NOTHING`,
];

// A commit holds a transaction lock on its number from when it takes it
// until it ends, in a key space of its own. Postgres releases the locks of a
// transaction only after its commit is visible (CommitTransaction in xact.c),
// so a number whose lock is gone is a commit that a new snapshot sees, or one
// that rolled back.
const numberLock = `hashtext('elt:commit')`;
// Taking a number and locking it are two steps, which a reader must not see
// between: each commit holds this lock shared across them, and a reader holds
// it alone while it reads the numbers taken and the locks held. It is the
// readers-writer lock of Courtois, Heymans and Parnas (1971) turned around,
// with the commits as the many readers, and a commit holds it only for those
// two steps, so no commit waits for another.
const gate = `hashtextextended('elt:commit-gate', 0)`;

// Makes the numbering if the database has none, under the lock of the shared
// schema: Postgres refuses to make one schema in two sessions at once (ADR
// 0003). One transaction makes all of it, so its epoch tells that it is
// there, and the DDL runs only while it is not: CREATE INDEX IF NOT EXISTS
// takes a share lock on its table even when the index exists, which would
// wait for every commit in flight. A session that waited for the lock finds
// the objects another one made, which IF NOT EXISTS skips.
export async function installNumbering(sql: postgres.Sql): Promise<void> {
  const [numbering] =
    await sql`SELECT to_regclass(${epochs}) IS NOT NULL AS "made"`;
  if (numbering?.made === true) return;
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${schemaLock(shared)}, 0))`;
    for (const statement of tables) await transaction.unsafe(statement);
  });
}

// Records a load of connector that opens at openedAt, and gives its id. A
// connection runs one pass at a time, so a load of it that is still open is
// one whose process ended during it: the new load closes it, as the sync
// history of a sole writer fails such a pass.
export async function openLoad(
  sql: postgres.Sql,
  connector: string,
  openedAt: Date,
): Promise<string> {
  return sql.begin(async (transaction) => {
    const [load] = await transaction<{ id: string }[]>`
      INSERT INTO ${transaction.unsafe(loads)} ("connector", "opened_at")
      VALUES (${connector}, ${openedAt}) RETURNING "id"`;
    if (load === undefined) throw new Error('The load was not recorded');
    await transaction`
      UPDATE ${transaction.unsafe(loads)} SET "closed_at" = ${openedAt}
      WHERE "connector" = ${connector} AND "closed_at" IS NULL AND "id" <> ${load.id}`;
    return load.id;
  });
}

export async function closeLoad(
  sql: Queries,
  load: string,
  closedAt: Date,
): Promise<void> {
  await sql`
    UPDATE ${sql.unsafe(loads)} SET "closed_at" = ${closedAt}
    WHERE "id" = ${load} AND "closed_at" IS NULL`;
}

// Takes the next number inside the transaction of a commit of load, and
// records the commit. A load that a later load of its connector closed has
// ended, and a commit after its end would move a position that readers were
// already given: the commit locks the row of its load, so a close that runs
// at the same time waits for the commit or makes it fail.
export async function commitNumber(
  sql: Queries,
  { load, connector }: { load: string; connector: string },
  committedAt: Date,
  retention: Temporal.Duration,
): Promise<number> {
  await sql`SELECT pg_advisory_lock_shared(${sql.unsafe(gate)})`;
  const [taken] = await sql<{ number: number }[]>`
    SELECT "number", pg_advisory_xact_lock(${sql.unsafe(numberLock)}, "number")
    FROM (SELECT nextval(${numbers})::integer AS "number") AS "next"`;
  await sql`SELECT pg_advisory_unlock_shared(${sql.unsafe(gate)})`;
  if (taken === undefined) throw new Error('No commit number was taken');
  const [open] = await sql`
    SELECT 1 FROM ${sql.unsafe(loads)}
    WHERE "id" = ${load} AND "closed_at" IS NULL FOR SHARE`;
  if (open === undefined)
    throw new Error(
      `A later load of connection ${connector} closed this load, so it cannot commit; a connection runs one pass at a time`,
    );
  await sql`
    INSERT INTO ${sql.unsafe(commits)} ("number", "load", "committed_at")
    VALUES (${taken.number}, ${load}, ${committedAt})`;
  await retain(sql, committedAt, retention);
  return taken.number;
}

// Applies the retention inside a commit's transaction, as Delta Lake expires
// its log at a checkpoint: the newest position whose commit is older than the
// window becomes min_valid. It is a position, so the newest position stays
// readable while a pass stays open longer than the window. Each writer then
// deletes the rows of its own target's history that only readings before it
// read. One numbering serves every destination of the database, so the
// shortest retention among them decides.
//
// The numbering then keeps no commit before min_valid and no closed load left
// with none, so it holds only what a reading still reads: min_valid is a
// position, so each load that has a commit before it ends at or before it,
// and keeps min_valid's own commit, whose committed_at a reading there reads.
// A committed_in of a row only compares with numbers, and needs no commit
// row. An open load keeps its row with or without commits. Commits of other
// connectors run at the same time, so min_valid only moves forward: the row
// of the epoch is locked until the commit that moved it ends, and a commit
// that read an older min_valid before that finds it moved and deletes nothing.
async function retain(
  sql: Queries,
  at: Date,
  retention: Temporal.Duration,
): Promise<void> {
  const cutoff = new Date(at.getTime() - retention.total('milliseconds'));
  const [row] = await sql<{ older: number; min_valid: number }[]>`
    SELECT (SELECT coalesce(max("number"), 0) FROM ${sql.unsafe(commits)} WHERE "committed_at" < ${cutoff}) AS "older", "min_valid"
    FROM ${sql.unsafe(epochs)}`;
  if (row === undefined || row.older <= row.min_valid) return;
  const numbered = await numberingIn(sql, row.older);
  const expired = numbered?.ends.at(-1);
  if (expired === undefined || expired <= row.min_valid) return;
  const moved = await sql`
    UPDATE ${sql.unsafe(epochs)} SET "min_valid" = ${expired}, "expired_by" = 'retention'
    WHERE "min_valid" < ${expired} RETURNING 1`;
  if (moved.length === 0) return;
  await sql`DELETE FROM ${sql.unsafe(commits)} WHERE "number" < ${expired}`;
  await sql`
    DELETE FROM ${sql.unsafe(loads)} AS l
    WHERE l."closed_at" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${sql.unsafe(commits)} AS c WHERE c."load" = l."id")`;
}

// The oldest commit that a reading can read as of, inside the transaction
// sql runs in.
export async function minValid(
  sql: Pick<postgres.Sql, 'unsafe'>,
): Promise<number> {
  const [row] = await sql.unsafe<{ min_valid: number }[]>(
    `SELECT "min_valid" FROM ${epochs}`,
  );
  return row?.min_valid ?? 0;
}

// Lets go of the gate that a commit holds while it takes its number. A commit
// that failed between taking the gate and letting it go left it held by the
// session, which outlives the transaction; letting go of a lock the session
// does not hold only warns.
export async function releaseGate(sql: postgres.Sql): Promise<void> {
  await sql`SELECT pg_advisory_unlock_shared(${sql.unsafe(gate)})`;
}

// The number of a change that is a load of one commit, such as a clear,
// taken inside the caller's transaction: the load opens, commits and closes
// in it. It is not a pass, so it leaves the open loads of its connector open.
export async function commitOnce(
  sql: Queries,
  connector: string,
  at: Date,
  retention: Temporal.Duration,
): Promise<number> {
  const [load] = await sql<{ id: string }[]>`
    INSERT INTO ${sql.unsafe(loads)} ("connector", "opened_at")
    VALUES (${connector}, ${at}) RETURNING "id"`;
  if (load === undefined) throw new Error('The load was not recorded');
  const number = await commitNumber(
    sql,
    { load: load.id, connector },
    at,
    retention,
  );
  await closeLoad(sql, load.id, at);
  return number;
}

// Makes each position before the commit changedIn expire, inside that
// commit.
export async function expireBefore(
  sql: Pick<postgres.Sql, 'unsafe'>,
  changedIn: number,
): Promise<void> {
  await sql.unsafe(
    `UPDATE ${epochs} SET "min_valid" = $1, "expired_by" = 'type' WHERE "min_valid" < $1`,
    [changedIn],
  );
}

// The numbering of a database, as one reader saw it.
export type Numbering = {
  readonly epoch: string;
  // The oldest commit that a reading can read as of, and what set it last.
  readonly minValid: number;
  readonly expiredBy: 'retention' | 'type' | null;
  // Every number at or below it is a commit that a reader sees, or one that
  // rolled back: the high-water mark of event stores, which skips the gaps
  // that rolled back and stops below the first number still in flight.
  readonly settled: number;
  // The commits that are positions, from minValid to settled, ascending.
  readonly ends: readonly number[];
};

// The high-water mark of the numbering, or null when the database has none.
// pg_locks is not read in a snapshot, so a reader takes the mark first and
// its snapshot after: each commit at or below the mark has ended by then, so
// the snapshot sees it.
export async function settledMark(sql: postgres.Sql): Promise<number | null> {
  try {
    return await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(${transaction.unsafe(gate)})`;
      const [mark] = await transaction<
        { taken: number; held: number | null }[]
      >`
        SELECT CASE WHEN "is_called" THEN "last_value" ELSE 0 END::integer AS "taken",
          (SELECT min("objid"::bigint)::integer FROM pg_locks
            WHERE "locktype" = 'advisory' AND "objsubid" = 2
              AND "database" = (SELECT "oid" FROM pg_database WHERE "datname" = current_database())
              AND "classid" = (${transaction.unsafe(numberLock)}::bigint & 4294967295)::oid) AS "held"
        FROM ${transaction.unsafe(numbers)}`;
      if (mark === undefined) throw new Error('The sequence has no row');
      return mark.held === null ? mark.taken : mark.held - 1;
    });
  } catch (error) {
    if (Object(error).code === '42P01') return null;
    throw error;
  }
}

// The numbering as the snapshot of the transaction sql runs in sees it, with
// settled taken before the snapshot. A position is a commit that ends a
// closed load where no load straddles it, so a reader there sees no part of
// a pass. Commits past the mark that the snapshot sees still reach across
// the ends before them.
export async function numberingIn(
  sql: Queries,
  settled: number,
): Promise<Numbering | null> {
  const [row] = await sql<
    {
      epoch: string;
      min_valid: number;
      expired_by: 'retention' | 'type' | null;
    }[]
  >`SELECT "epoch", "min_valid", "expired_by" FROM ${sql.unsafe(epochs)}`;
  if (row === undefined) return null;
  const spans = (
    await sql<{ first: number; last: number | null }[]>`
      SELECT min(c."number") AS "first",
        CASE WHEN l."closed_at" IS NULL THEN NULL ELSE max(c."number") END AS "last"
      FROM ${sql.unsafe(commits)} AS c
      JOIN ${sql.unsafe(loads)} AS l ON l."id" = c."load"
      GROUP BY l."id" ORDER BY "first"`
  ).map(({ first, last }) => ({ first, last: last ?? Infinity }));
  return {
    epoch: row.epoch,
    minValid: row.min_valid,
    expiredBy: row.expired_by,
    settled,
    ends: ends(spans, settled).filter((end) => end >= row.min_valid),
  };
}

// When the commit numbered number was made, and the newest number that the
// snapshot of the transaction sql runs in sees.
export async function committedAt(
  sql: Queries,
  number: number,
): Promise<{ readonly at: Date; readonly newest: number } | undefined> {
  const [row] = await sql<{ at: Date; newest: number }[]>`
    SELECT "committed_at" AS "at", (SELECT max("number") FROM ${sql.unsafe(commits)}) AS "newest"
    FROM ${sql.unsafe(commits)} WHERE "number" = ${number}`;
  return row;
}

async function readNumbering(sql: postgres.Sql): Promise<Numbering | null> {
  const settled = await settledMark(sql);
  if (settled === null) return null;
  return sql.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', (transaction) =>
    numberingIn(transaction, settled),
  );
}

// A sweep line over the loads in order of their first commits: an end is a
// position when no load that began at or before it ends after it. An open
// load has no end yet, so it reaches past every later commit.
function ends(
  spans: readonly { first: number; last: number }[],
  settled: number,
): number[] {
  const found: number[] = [];
  const pending = spans.values();
  let span = pending.next();
  let reach = 0;
  for (const end of spans
    .map(({ last }) => last)
    .filter((last) => last <= settled)
    .sort((left, right) => left - right)) {
    for (; !span.done && span.value.first <= end; span = pending.next())
      reach = Math.max(reach, span.value.last);
    if (reach === end) found.push(end);
  }
  return found;
}

// The positions of the database after `after`, ascending, or all of them. A
// position of another epoch, or past the newest settled commit, is expired.
export async function positionsAfter(
  sql: postgres.Sql,
  after: string | undefined,
): Promise<readonly string[] | { readonly expired: string }> {
  const since = after === undefined ? undefined : parsePosition(after);
  const numbered = await readNumbering(sql);
  if (since === undefined)
    return numbered === null
      ? []
      : numbered.ends.map((end) => `${numbered.epoch}:${end}`);
  const expired = expiry(numbered, since);
  if (expired !== undefined) return { expired };
  return (numbered?.ends ?? [])
    .filter((end) => end > since.number)
    .map((end) => `${since.epoch}:${end}`);
}

export type Position = { readonly epoch: string; readonly number: number };

export function expiry(
  numbered: Numbering | null,
  { epoch, number }: Position,
): string | undefined {
  const position = `${epoch}:${number}`;
  if (numbered === null)
    return `Position ${position} is of commits this database does not have`;
  if (epoch !== numbered.epoch)
    return `Position ${position} is of an earlier numbering: the commits of this database were numbered again since`;
  if (number > numbered.settled)
    return `Position ${position} is past the newest commit of this database, ${numbered.settled}`;
  if (number < numbered.minValid)
    return numbered.expiredBy === 'type'
      ? `Position ${position} is before commit ${numbered.minValid}, which changed the type of a column to one that does not hold each earlier value: the history keeps no row that only a reading before that commit reads`
      : `Position ${position} is before commit ${numbered.minValid}, the oldest position that the retention of the database keeps readable: the history keeps no row that only a reading before it reads`;
  return undefined;
}

export function parsePosition(position: string): Position {
  const groups = /^(?<epoch>[^:]+):(?<number>0|[1-9]\d*)$/.exec(
    position,
  )?.groups;
  if (groups?.epoch === undefined || groups.number === undefined)
    throw new TypeError(`${position} is not a position of a Postgres database`);
  return { epoch: groups.epoch, number: Number(groups.number) };
}
