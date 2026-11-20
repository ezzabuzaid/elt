import {
  Int64Format,
  LocalTimestampFormat,
  type Stream,
  schemaColumns,
} from '@eltjs/elt';

import { SQLiteColumn, type SQLiteColumnType } from './sqlite-column.ts';

// SQLite column declarations are independent of a source or connection.
export class SQLiteColumns {
  // Scalars, and arrays of scalars or of objects as JSON arrays in TEXT.
  // String formats keep their kind, as in Postgres.
  static fromSchema(schema: Stream['jsonSchema']): readonly SQLiteColumn[] {
    return schemaColumns(schema, 'SQLite').map(
      ({ field, type, ...options }) =>
        new SQLiteColumn(field, type, { ...options, primaryKey: false }),
    );
  }

  text(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'text', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  integer(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'integer', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  // A signed 64-bit integer, which a stream spells as decimal text (format
  // int64), so a value past Number.MAX_SAFE_INTEGER keeps every digit.
  int64(field: string): SQLiteColumn {
    return new SQLiteColumn(field, new Int64Format(), {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  real(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'real', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  date(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'date', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  timestamp(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'timestamp', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  // A wall-clock date and time with no zone and precision digits of a second
  // (format date-time-local), as SQL Server's datetime2 holds it.
  localTimestamp(field: string, precision: number): SQLiteColumn {
    return new SQLiteColumn(field, new LocalTimestampFormat(precision), {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  blob(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'blob', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }

  boolean(field: string): SQLiteColumn {
    return new SQLiteColumn(field, 'boolean', {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }
}
