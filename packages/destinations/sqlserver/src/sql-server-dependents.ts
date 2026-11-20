import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

// The errors of a change that a view WITH SCHEMABINDING stops: a rename of a
// table it reads (15336), a drop of one (3729), and a change or drop of a
// column it reads (4922) (ADR 0006).
const boundNumbers = new Set([15336, 3729, 4922]);

// The error of sp_refreshview for a view that reads a column that the change
// dropped.
const invalidColumn = 207;

const numberOf = (error: unknown) =>
  Error.isError(error) && 'number' in error ? error.number : undefined;

// Runs change, which replaces or changes the roots, and then refreshes each
// view that reads one of them, directly or through other views, the
// shallowest first, so a view over * shows the new columns (ADR 0006).
// sql_expression_dependencies keeps a dependency by name, so it finds the
// views of a table that took the name of another. A view that the change no
// longer fits, or one WITH SCHEMABINDING that stops it, fails the change with
// an error that names the view; the caller's transaction then keeps the
// tables as they were. Each root names a relation of the database; views
// skips the ones that change makes again itself.
export async function refreshDependents(
  connection: SqlServerConnection,
  { roots, views, changed }: Dependents,
  change: () => Promise<void>,
): Promise<void> {
  try {
    await change();
  } catch (error) {
    if (!boundNumbers.has(Number(numberOf(error)))) throw error;
    const bound = await connection.query(
      `SELECT DISTINCT QUOTENAME(OBJECT_SCHEMA_NAME(d.[referencing_id])) + N'.' + QUOTENAME(OBJECT_NAME(d.[referencing_id])) AS [view]
       FROM sys.sql_expression_dependencies AS d
       WHERE d.[is_schema_bound_reference] = 1 AND d.[referenced_id] IN (SELECT OBJECT_ID([value]) FROM OPENJSON(@roots))
       ORDER BY [view]`,
      { roots: JSON.stringify(roots) },
    );
    throw new TypeError(
      `${bound.map(({ view }) => String(view)).join(', ')} WITH SCHEMABINDING stops the change of ${changed}; drop the view or make it again without SCHEMABINDING: ${Error.isError(error) ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const readers = await connection.query(
    `WITH [readers] AS (
       SELECT d.[referencing_id] AS [id], 1 AS [depth] FROM sys.sql_expression_dependencies AS d
       WHERE d.[referenced_id] IN (SELECT OBJECT_ID([value]) FROM OPENJSON(@roots))
       UNION ALL
       SELECT d.[referencing_id], r.[depth] + 1 FROM [readers] AS r
       JOIN sys.sql_expression_dependencies AS d ON d.[referenced_id] = r.[id]
     )
     SELECT QUOTENAME(OBJECT_SCHEMA_NAME([id])) + N'.' + QUOTENAME(OBJECT_NAME([id])) AS [view]
     FROM [readers]
     WHERE OBJECTPROPERTY([id], 'IsView') = 1 AND [id] NOT IN (SELECT OBJECT_ID([value]) FROM OPENJSON(@views))
     GROUP BY [id] ORDER BY MAX([depth]), [view]`,
    { roots: JSON.stringify(roots), views: JSON.stringify(views) },
  );
  for (const { view } of readers)
    try {
      await connection.query('EXEC sp_refreshview @view', {
        view: String(view),
      });
    } catch (error) {
      if (numberOf(error) !== invalidColumn) throw error;
      throw new TypeError(
        `${String(view)} reads ${changed} and does not fit its change: ${Error.isError(error) ? error.message : String(error)}`,
        { cause: error },
      );
    }
}

// What a change replaces: the relations whose readers it refreshes, the views
// among them that it makes again itself, and the table it changes, which
// its errors name.
type Dependents = {
  readonly roots: readonly string[];
  readonly views: readonly string[];
  readonly changed: string;
};
