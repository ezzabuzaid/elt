import type { SqlServerTable } from '@workspace/sdk-microsoft-sql-server';

import { ChangeSignal, type Check } from './change-signal.ts';

// The statistics of each table: SQL Server counts the rows that an insert,
// a delete, a TRUNCATE or an update of a column with statistics changes, and
// keeps the count through a restart. An update of a column with no
// statistics moves nothing.
class StatisticsChanges extends ChangeSignal {
  async read({ session }: Check) {
    const counts = await session.statistics();
    // A table dropped since discovery has no value, which wakes its stream,
    // whose read then fails.
    return (table: SqlServerTable) => counts.get(table.quoted);
  }
}

export const statisticsChanges = new StatisticsChanges();
