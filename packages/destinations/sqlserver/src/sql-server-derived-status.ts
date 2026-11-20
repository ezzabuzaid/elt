import { DerivedStatus, type PipelineClock } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { lockSchema, transaction } from './sql-server-connection.ts';
import { inWarehouse, warehouse } from './sql-server-schemas.ts';

const table = inWarehouse('derived_status');

// One row for each derived dataset of the database: what its refreshes left,
// which readers see through marts.derived_status. The sync history makes it
// with its tables, and a dataset makes it too, so it never depends on the
// order of the two.
export const derivedStatusTable = `
  IF OBJECT_ID(N'${table}', N'U') IS NULL
    CREATE TABLE ${table} (
      [dataset] nvarchar(300) NOT NULL PRIMARY KEY,
      [kind] nvarchar(20) NOT NULL CHECK ([kind] IN (N'view', N'computed')),
      [state] nvarchar(20) NOT NULL CHECK ([state] IN (N'waiting', N'refreshing', N'current', N'failed')),
      [as_of] datetimeoffset(3) NULL, [refreshed_at] datetimeoffset(3) NULL, [refreshing_since] datetimeoffset(3) NULL, [error] nvarchar(max) NULL,
      [inputs] bigint NULL, [computed] bigint NULL, [empty] bigint NULL, [failed] bigint NULL, [pending] bigint NULL);`;

// The derived_status of the database, where dataset is the view of the
// dataset in marts, such as marts.lengths.
export class SqlServerDerivedStatus extends DerivedStatus {
  readonly #connection: SqlServerConnection;
  readonly #dataset: string;
  readonly #kind: 'view' | 'computed';

  // connection is a session outside any transaction, between the dataset's
  // own.
  constructor(
    connection: SqlServerConnection,
    dataset: string,
    kind: 'view' | 'computed',
    clock: PipelineClock,
  ) {
    super(clock);
    this.#connection = connection;
    this.#dataset = dataset;
    this.#kind = kind;
  }

  // Inside the transaction of a commit that settled count inputs, on the
  // session of the status.
  async settled(count: number): Promise<void> {
    await this.#connection.query(
      `UPDATE ${table} SET [pending] = GREATEST([pending] - CAST(@count AS bigint), 0) WHERE [dataset] = @dataset`,
      { count: String(count), dataset: this.#dataset },
    );
  }

  // In a transaction of its own, which takes no commit number: the status is
  // no data of a position. The lock of _warehouse serializes the make of the
  // table, and the update and the insert of one row. Each value is text,
  // which SQL Server converts to the type of its column: an ISO 8601 time to
  // datetimeoffset, a count to bigint.
  protected override async write(
    values: Readonly<Record<string, string | number | null>>,
  ): Promise<void> {
    const columns = ['kind', ...Object.keys(values)];
    await transaction(this.#connection, async () => {
      await lockSchema(this.#connection, warehouse);
      await this.#connection.query(
        `IF SCHEMA_ID(N'${warehouse}') IS NULL EXEC (N'CREATE SCHEMA [${warehouse}]');`,
      );
      await this.#connection.query(derivedStatusTable);
      await this.#connection.query(
        `UPDATE ${table} SET ${columns.map((column) => `[${column}] = @${column}`).join(', ')} WHERE [dataset] = @dataset;
         IF @@ROWCOUNT = 0
           INSERT INTO ${table} ([dataset], ${columns.map((column) => `[${column}]`).join(', ')})
           VALUES (@dataset, ${columns.map((column) => `@${column}`).join(', ')});`,
        {
          dataset: this.#dataset,
          kind: this.#kind,
          ...Object.fromEntries(
            Object.entries(values).map(([column, value]) => [
              column,
              value === null ? null : String(value),
            ]),
          ),
        },
      );
    });
  }
}
