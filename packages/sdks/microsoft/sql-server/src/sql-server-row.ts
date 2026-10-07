import type { SqlServerColumn } from './sql-server-column.ts';
import type { SqlServerTable } from './sql-server-table.ts';
import type { SqlServerValue } from './values.ts';

export class SqlServerRow {
  readonly table: SqlServerTable;
  // One value per readable column, in the table's column order.
  readonly values: readonly SqlServerValue[];

  constructor(table: SqlServerTable, values: readonly SqlServerValue[]) {
    this.table = table;
    this.values = values;
    Object.freeze(this);
  }

  value(column: SqlServerColumn): SqlServerValue {
    const index = this.table.columns.indexOf(column);
    if (index === -1)
      throw new TypeError(`${this.table.quoted} has no column ${column.name}`);
    return this.values[index] ?? null;
  }

  // Where this row sits in primary key order, as text a page reads after.
  get position(): readonly string[] {
    return this.table.primaryKey.map((column) => {
      const value = this.value(column);
      if (value === null)
        throw new TypeError(`${this.table.quoted} key ${column.name} is null`);
      return column.codec.position(value);
    });
  }
}
