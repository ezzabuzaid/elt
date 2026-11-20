import {
  Int64Format,
  LocalTimestampFormat,
  type Stream,
  schemaColumns,
} from '@eltjs/elt';

import {
  SqlServerColumn,
  type SqlServerColumnType,
} from './sql-server-column.ts';

// SQL Server column declarations are independent of a source or connection.
export class SqlServerColumns {
  // Scalars and arrays of scalars, as in elt-postgresql: the string formats
  // get their own types, so readers can do date arithmetic without parsing
  // text, and an array is a JSON array of its items.
  static fromSchema(schema: Stream['jsonSchema']): readonly SqlServerColumn[] {
    return schemaColumns(schema, 'SQL Server').map(
      ({ field, type, ...options }) =>
        new SqlServerColumn(field, type, { ...options, primaryKey: false }),
    );
  }

  text(field: string): SqlServerColumn {
    return this.#column(field, 'text');
  }

  integer(field: string): SqlServerColumn {
    return this.#column(field, 'integer');
  }

  // A signed 64-bit integer, which a stream spells as decimal text (format
  // int64), so a value past Number.MAX_SAFE_INTEGER keeps every digit.
  int64(field: string): SqlServerColumn {
    return this.#column(field, new Int64Format());
  }

  real(field: string): SqlServerColumn {
    return this.#column(field, 'real');
  }

  boolean(field: string): SqlServerColumn {
    return this.#column(field, 'boolean');
  }

  date(field: string): SqlServerColumn {
    return this.#column(field, 'date');
  }

  timestamp(field: string): SqlServerColumn {
    return this.#column(field, 'timestamp');
  }

  // A wall-clock date and time with no zone and precision digits of a second
  // (format date-time-local), as SQL Server's datetime2 holds it.
  localTimestamp(field: string, precision: number): SqlServerColumn {
    return this.#column(field, new LocalTimestampFormat(precision));
  }

  blob(field: string): SqlServerColumn {
    return this.#column(field, 'blob');
  }

  #column(field: string, type: SqlServerColumnType): SqlServerColumn {
    return new SqlServerColumn(field, type, {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }
}
