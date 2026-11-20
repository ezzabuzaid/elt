import { parsePosition, readingExpiry } from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import { connect } from './sql-server-connection.ts';
import {
  committedAt,
  numberingIn,
  requireRowVersions,
  settledMark,
  sqlServerDatabase,
} from './sql-server-numbering.ts';
import { now } from './sql-server-reader-view.ts';

/**
 * The database as of one position: `sql` is a session of its own in one
 * SNAPSHOT transaction, and each reader view, and each view over one, shows
 * its target as it was at that position. Dispose it to end the session.
 */
export type SqlServerReading = {
  readonly sql: SqlServerConnection;
  readonly position: string;
  // When the commit of the position was made.
  readonly at: Temporal.Instant;
} & AsyncDisposable;

// Reads the database as of the position, or as of its newest position. The
// high-water mark is read before the snapshot, so the snapshot sees each
// commit at or below it; one SNAPSHOT transaction then holds the snapshot
// that the numbering and every later read see, so a commit after the
// reading begins shows in none of them. The session context keeps the
// position as a read-only key, which each reader view reads and the reader
// cannot change: below the newest commit that the snapshot sees, the number
// of the position, and else now, as a session that sets none reads
// (ADR 0010). A session context value is a sql_variant, which holds no
// nvarchar(max), so the number goes as a bigint.
export async function readAsOf(
  database: SqlServerDatabase,
  position: string | undefined,
): Promise<SqlServerReading | { readonly expired: string }> {
  const asked =
    position === undefined
      ? undefined
      : parsePosition(position, sqlServerDatabase);
  await using stack = new AsyncDisposableStack();
  const connection = stack.use(await connect(database));
  await requireRowVersions(connection);
  const settled = await settledMark(connection);
  if (settled === null) return { expired: 'No load has committed yet' };
  await connection.query(
    'SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRANSACTION',
  );
  const numbered = await numberingIn(connection, settled);
  if (asked !== undefined) {
    const expired = readingExpiry(
      numbered,
      asked,
      sqlServerDatabase,
      'the database',
    );
    if (expired !== undefined) return { expired };
  }
  const number = asked?.number ?? numbered?.ends.at(-1);
  const commit =
    number === undefined ? undefined : await committedAt(connection, number);
  if (numbered === null || number === undefined || commit === undefined)
    return {
      expired:
        position === undefined
          ? 'The database has no position yet'
          : `Position ${position} names no commit of the database`,
    };
  await connection.query(
    `DECLARE @position bigint = CAST(@number AS bigint);
     EXEC sp_set_session_context @key = N'elt.position', @value = @position, @read_only = 1;`,
    { number: number < commit.newest ? String(number) : now },
  );
  const owned = stack.move();
  return {
    sql: connection,
    position: `${numbered.epoch}:${number}`,
    at: Temporal.Instant.fromEpochMilliseconds(commit.at.getTime()),
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}
