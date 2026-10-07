import sql from 'mssql';

import { SqlServerPermissionError } from './errors.ts';

// Every parameter travels as text and the statement casts it, so a value
// keeps the exact spelling a read gave it, whatever the driver would make of
// a number or a Date.
function bind(request: sql.Request, parameters: readonly string[]): void {
  for (const [index, value] of parameters.entries())
    request.input(`p${index}`, sql.NVarChar(sql.MAX), value);
}

// A refused read names the grant it needs (errors 229 and 230).
function readError(error: unknown): unknown {
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
  text: string,
  parameters: readonly string[] = [],
): Promise<unknown[][]> {
  request.arrayRowMode = true;
  bind(request, parameters);
  try {
    const { recordset } = await request.query(text);
    return recordset.map(asRow);
  } catch (error) {
    throw readError(error);
  }
}

// The rows of one statement as the driver receives them; stopping early
// cancels the statement so its connection returns to the pool.
export async function* stream(
  request: sql.Request,
  text: string,
  parameters: readonly string[] = [],
): AsyncGenerator<unknown[]> {
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
  // In stream mode the promise always resolves; failures arrive on rows.
  void request.query(text);
  try {
    for await (const row of rows) {
      yield asRow(row);
    }
  } catch (error) {
    throw readError(error);
  } finally {
    // A reader that stops early cancels the statement, and waits for it to
    // end: until then the connection, or a transaction on it, is not free.
    if (!finished) {
      rows.on('error', () => {});
      request.cancel();
      await ended;
    }
  }
}
