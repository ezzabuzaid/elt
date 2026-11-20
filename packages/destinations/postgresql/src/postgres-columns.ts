import {
  Int64Format,
  LocalTimestampFormat,
  type Stream,
  schemaColumns,
} from '@eltjs/elt';

import { PostgresColumn, type PostgresColumnType } from './postgres-column.ts';

// Postgres column declarations are independent of a source or connection.
export class PostgresColumns {
  // Scalars and arrays of scalars. Unlike SQLite, the string formats get their
  // own types, so readers can do date arithmetic without parsing text, and an
  // array is a native array of its item type.
  static fromSchema(schema: Stream['jsonSchema']): readonly PostgresColumn[] {
    return schemaColumns(schema, 'Postgres').map(
      ({ field, type, ...options }) =>
        new PostgresColumn(field, type, { ...options, primaryKey: false }),
    );
  }

  text(field: string): PostgresColumn {
    return this.#column(field, 'text');
  }

  integer(field: string): PostgresColumn {
    return this.#column(field, 'integer');
  }

  // A signed 64-bit integer, which a stream spells as decimal text (format
  // int64), so a value past Number.MAX_SAFE_INTEGER keeps every digit.
  int64(field: string): PostgresColumn {
    return this.#column(field, new Int64Format());
  }

  real(field: string): PostgresColumn {
    return this.#column(field, 'real');
  }

  boolean(field: string): PostgresColumn {
    return this.#column(field, 'boolean');
  }

  date(field: string): PostgresColumn {
    return this.#column(field, 'date');
  }

  timestamp(field: string): PostgresColumn {
    return this.#column(field, 'timestamp');
  }

  // A wall-clock date and time with no zone and precision digits of a second
  // (format date-time-local), as SQL Server's datetime2 holds it.
  localTimestamp(field: string, precision: number): PostgresColumn {
    return this.#column(field, new LocalTimestampFormat(precision));
  }

  blob(field: string): PostgresColumn {
    return this.#column(field, 'blob');
  }

  #column(field: string, type: PostgresColumnType): PostgresColumn {
    return new PostgresColumn(field, type, {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }
}
