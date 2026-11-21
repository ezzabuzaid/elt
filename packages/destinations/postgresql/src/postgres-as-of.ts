import type postgres from 'postgres';

import { parsePosition, readingNumber } from '@eltjs/elt';

import {
  committedAt,
  numberingIn,
  postgresDatabase,
  settledMark,
} from './postgres-numbering.ts';
import { PostgresSession } from './postgres-session.ts';

/**
 * The database as of one position: `sql` reads in one read-only transaction
 * of its own session, and each reader view, and each view over one, shows
 * its target as it was at that position. Dispose it to end the session.
 */
export type PostgresReading = {
  readonly sql: postgres.Sql;
  readonly position: string;
  // When the commit of the position was made.
  readonly at: Temporal.Instant;
} & AsyncDisposable;

// Reads the database as of the position, or as of its newest position. The
// high-water mark is taken before the snapshot, so the snapshot sees each
// commit at or below it; one REPEATABLE READ transaction then holds the
// snapshot that the numbering and every later read see, so a commit after
// the reading begins shows in none of them. Below the newest commit the
// snapshot sees, the transaction sets elt.position, which each reader view
// reads; no read makes or changes an object.
export async function readAsOf(
  url: string,
  position: string | undefined,
): Promise<PostgresReading | { readonly expired: string }> {
  const asked =
    position === undefined
      ? undefined
      : parsePosition(position, postgresDatabase);
  await using stack = new AsyncDisposableStack();
  const { sql } = stack.use(new PostgresSession(url, 'elt-reading'));
  const settled = await settledMark(sql);
  if (settled === null) return { expired: 'No load has committed yet' };
  await sql.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  stack.defer(async () => {
    await sql.unsafe('ROLLBACK');
  });
  const read = readingNumber(
    await numberingIn(sql, settled),
    asked,
    postgresDatabase,
    'the database',
  );
  if ('expired' in read) return read;
  const { epoch, number } = read;
  const commit = await committedAt(sql, number);
  if (commit === undefined)
    return {
      expired: `Position ${epoch}:${number} names no commit of the database`,
    };
  if (number < commit.newest)
    await sql`SELECT set_config('elt.position', ${String(number)}, true)`;
  const owned = stack.move();
  return {
    sql,
    position: `${epoch}:${number}`,
    at: Temporal.Instant.fromEpochMilliseconds(commit.at.getTime()),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
