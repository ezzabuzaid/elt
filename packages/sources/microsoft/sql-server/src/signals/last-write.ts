import type { SqlServerTable } from '@workspace/sdk-microsoft-sql-server';

import { ChangeSignal, type Check } from './change-signal.ts';

// When SQL Server last wrote to each table: any insert, update or delete
// moves it, also of a column with no statistics. A restart forgets it, which
// changes the value of every table that SQL Server wrote to before.
class LastWrite extends ChangeSignal {
  async read({ session }: Check) {
    const writes = await session.lastWrites();
    // A table dropped since discovery has no value, which wakes its stream,
    // whose read then fails.
    return (table: SqlServerTable) => writes.get(table.quoted);
  }
}

export const lastWrite = new LastWrite();
