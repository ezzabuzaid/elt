import type { SqlServerTable } from '@workspace/sdk-microsoft-sql-server';

import { ChangeSignal, type Check } from './change-signal.ts';

// How many rows each table holds: an insert, a delete or a TRUNCATE moves
// it, also in a table whose statistics SQL Server has not built yet, which
// count nothing. An update moves nothing.
class RowCount extends ChangeSignal {
  async read({ session }: Check) {
    const counts = await session.rowCounts();
    // A table dropped since discovery has no value, which wakes its stream,
    // whose read then fails.
    return (table: SqlServerTable) => counts.get(table.quoted);
  }
}

export const rowCount = new RowCount();
