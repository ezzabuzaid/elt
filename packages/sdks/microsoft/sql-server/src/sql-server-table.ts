import { quoteName } from './quote-name.ts';
import type { SqlServerColumn } from './sql-server-column.ts';

// Whether the table keeps a Change Tracking history the login can read:
// denied means tracking is on but the login lacks VIEW CHANGE TRACKING.
export type ChangeTracking = 'off' | 'readable' | 'denied';

export class SqlServerTable {
  readonly schema: string;
  readonly name: string;
  // Its MS_Description extended property.
  readonly description: string | null;
  // The columns the login can read, in their declared order.
  readonly columns: readonly SqlServerColumn[];
  // The columns a column-level DENY keeps from the login.
  readonly unreadable: readonly string[];
  // Empty when the table has no primary key, or the login cannot read all of it.
  readonly primaryKey: readonly SqlServerColumn[];
  readonly changeTracking: ChangeTracking;

  constructor(table: {
    schema: string;
    name: string;
    description: string | null;
    columns: readonly SqlServerColumn[];
    unreadable: readonly string[];
    primaryKey: readonly SqlServerColumn[];
    changeTracking: ChangeTracking;
  }) {
    this.schema = table.schema;
    this.name = table.name;
    this.description = table.description;
    this.columns = Object.freeze([...table.columns]);
    this.unreadable = Object.freeze([...table.unreadable]);
    this.primaryKey = Object.freeze([...table.primaryKey]);
    this.changeTracking = table.changeTracking;
    Object.freeze(this);
  }

  get quoted(): string {
    return `${quoteName(this.schema)}.${quoteName(this.name)}`;
  }

  // The rowversion column, which SQL Server sets on every insert and update.
  get rowversion(): SqlServerColumn | undefined {
    return this.columns.find((column) => column.type === 'timestamp');
  }

  // Whether reads can page through the table in primary key order.
  get pageable(): boolean {
    return (
      this.primaryKey.length > 0 &&
      this.primaryKey.every((column) => column.codec.cast('@p') !== undefined)
    );
  }
}
