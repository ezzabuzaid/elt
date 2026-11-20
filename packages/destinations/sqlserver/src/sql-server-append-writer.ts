import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import type { SqlServerColumn } from './sql-server-column.ts';
import type { TargetHistory } from './sql-server-history.ts';
import {
  SqlServerWriter,
  type Written,
  seq,
  writtenParameters,
} from './sql-server-writer.ts';

// Appends each record of a stream to its raw table, in the order the source
// gave them. A key that the columns declare is unique, so a commit that
// repeats one fails.
export class SqlServerAppendWriter extends SqlServerWriter {
  readonly keys: readonly SqlServerColumn[] = this.table.columns.filter(
    ({ isPrimaryKey }) => isPrimaryKey,
  );

  protected override async merge(
    connection: SqlServerConnection,
    stage: string,
    written: Written,
    into: string,
    _history: TargetHistory | null,
  ): Promise<boolean> {
    const [appended] = await connection.query(
      `INSERT INTO ${into} (${this.written.join(', ')})
       SELECT ${this.staged('[_elt_new]').join(', ')} FROM ${stage} AS [_elt_new] ORDER BY [_elt_new].${seq};
       SELECT @@ROWCOUNT AS [rows];`,
      writtenParameters(written),
    );
    return appended?.rows !== 0;
  }
}
