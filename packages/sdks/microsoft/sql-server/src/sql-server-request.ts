import sql from 'mssql';

import {
  SqlServerLoginError,
  SqlServerPermissionError,
  SqlServerUnavailableError,
} from './errors.ts';

// What one read waits on: the caller's clock, and the signal that stops it.
export type SqlServerRead = {
  readonly clock: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(timer: unknown): void;
  };
  readonly signal: AbortSignal | undefined;
};

// How often a read checks that rows still arrive. A read that got no row from
// one check to the next fails, so a server or network that stopped
// sending fails it within two hours, the limit of Airbyte's source-mssql
// (maxSecondsBetweenMessages: 7200 in its metadata.yaml). The driver has no such
// limit: its request timeout stops at the first data, and a read of a whole
// table can take any length of time.
const silenceCheckMs = 3_600_000;

// Every parameter travels as text and the statement casts it, so a value
// keeps the exact spelling a read gave it, whatever the driver would make of
// a number or a Date.
function bind(request: sql.Request, parameters: readonly string[]): void {
  for (const [index, value] of parameters.entries())
    request.input(`p${index}`, sql.NVarChar(sql.MAX), value);
}

// What a failed connection means, when the pool opened it or a statement lost
// it: a login the server refused is the user's to fix, and anything else can
// succeed at a later attempt.
export function connectionFailure(location: string, cause: unknown): Error {
  return refused(cause)
    ? new SqlServerLoginError(location, cause)
    : new SqlServerUnavailableError(location, cause);
}

// Whether the server answered and refused the login. Its errors while it fails
// over or is busy are marked as transient when the connection opens
// (SqlServerDatabase); those mean the server cannot be reached now.
function refused(error: unknown): boolean {
  if (!(error instanceof sql.ConnectionError) || error.code !== 'ELOGIN')
    return false;
  const { originalError } = error;
  return !(
    originalError !== undefined &&
    'isTransient' in originalError &&
    originalError.isTransient === true
  );
}

// A failed statement as what it means. The connection failed under it when
// the error has no server number, such as ECONNRESET, or when the server ended
// the session: SQL Server ends the connection at severity 20 and above, as
// error 596 does for a session that was killed. A refused read names the grant
// it needs (errors 229 and 230).
function readError(error: unknown, location: string): unknown {
  if (
    error instanceof sql.ConnectionError ||
    (error instanceof sql.RequestError &&
      (typeof error.number !== 'number' || Number(error.class) >= 20))
  )
    return connectionFailure(location, error);
  if (!(error instanceof sql.RequestError)) return error;
  if (error.number !== 229 && error.number !== 230) return error;
  const denied =
    /^The (.+) permission was denied on the (?:column '(.+)' of the )?object '(.+)', database '.+', schema '(.+)'\.$/.exec(
      error.message,
    );
  if (denied === null) return error;
  const [, permission, column, object, schema] = denied;
  const on = `[${schema}].[${object}]${column === undefined ? '' : ` ([${column}])`}`;
  return new SqlServerPermissionError(`${permission} ON ${on}`, error);
}

function asRow(row: unknown): unknown[] {
  if (!Array.isArray(row))
    throw new TypeError('SQL Server returned a row that is not a list');
  return row;
}

// Every row of one statement, each as the values it selects in order.
export async function query(
  request: sql.Request,
  location: string,
  text: string,
  parameters: readonly string[] = [],
): Promise<unknown[][]> {
  request.arrayRowMode = true;
  bind(request, parameters);
  try {
    const { recordset } = await request.query(text);
    return recordset.map(asRow);
  } catch (error) {
    throw readError(error, location);
  }
}

// The rows of one statement as the driver receives them; stopping early
// cancels the statement so its connection returns to the pool. The signal stops
// the read also while the driver has no row to give.
export async function* stream(
  request: sql.Request,
  text: string,
  parameters: readonly string[],
  { clock, signal }: SqlServerRead,
  location: string,
): AsyncGenerator<unknown[]> {
  signal?.throwIfAborted();
  request.arrayRowMode = true;
  bind(request, parameters);
  const rows = request.toReadableStream();
  // The driver ends every statement, cancelled or failed too, with done.
  const ended = new Promise<void>((resolve) =>
    request.once('done', () => resolve()),
  );
  let finished = false;
  void ended.then(() => {
    finished = true;
  });
  let arrived = false;
  const check = () => {
    if (arrived) {
      arrived = false;
      timer = clock.setTimeout(check, silenceCheckMs);
    } else
      rows.destroy(
        new SqlServerUnavailableError(
          location,
          new Error(`The server sent no row for over ${silenceCheckMs} ms`),
        ),
      );
  };
  let timer = clock.setTimeout(check, silenceCheckMs);
  const stop = () => rows.destroy(signal?.reason);
  signal?.addEventListener('abort', stop, { once: true });
  // In stream mode the promise always resolves; failures arrive on rows.
  void request.query(text);
  try {
    for await (const row of rows) {
      arrived = true;
      yield asRow(row);
    }
  } catch (error) {
    throw readError(error, location);
  } finally {
    clock.clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    // A reader that stops early cancels the statement, and waits for it to
    // end: until then the connection, or a transaction on it, is not free.
    if (!finished) {
      rows.on('error', () => {});
      request.cancel();
      await ended;
    }
  }
}
