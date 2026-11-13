import type postgres from 'postgres';

import {
  type Numbering,
  type Position,
  committedAt,
  expiry,
  numberingIn,
  parsePosition,
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
  const asked = position === undefined ? undefined : parsePosition(position);
  await using stack = new AsyncDisposableStack();
  const { sql } = stack.use(new PostgresSession(url, 'elt-reading'));
  const settled = await settledMark(sql);
  if (settled === null) return { expired: 'No load has committed yet' };
  await sql.unsafe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  stack.defer(async () => {
    await sql.unsafe('ROLLBACK');
  });
  const numbered = await numberingIn(sql, settled);
  if (asked !== undefined) {
    const expired = expiry(numbered, asked);
    if (expired !== undefined) return { expired };
    refuseInsidePass(numbered, asked);
  }
  const number = asked?.number ?? numbered?.ends.at(-1);
  const commit =
    number === undefined ? undefined : await committedAt(sql, number);
  if (numbered === null || number === undefined || commit === undefined)
    return {
      expired:
        position === undefined
          ? 'The database has no position yet'
          : `Position ${position} names no commit of the database`,
    };
  if (number < commit.newest)
    await sql`SELECT set_config('elt.position', ${String(number)}, true)`;
  const owned = stack.move();
  return {
    sql,
    position: `${numbered.epoch}:${number}`,
    at: Temporal.Instant.fromEpochMilliseconds(commit.at.getTime()),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

// No later load can straddle a position, so one that a reader was given
// stays one; a commit that is not a position stays inside its pass.
function refuseInsidePass(
  numbered: Numbering | null,
  { epoch, number }: Position,
): void {
  if (!numbered?.ends.includes(number))
    throw new TypeError(
      `${epoch}:${number} is not a position of the database: a reading of a commit inside a pass would show a part of that pass. Read a position that positions() lists.`,
    );
}
