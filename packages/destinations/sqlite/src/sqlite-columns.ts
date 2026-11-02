import {
  type DeclaredFormat,
  Int64Format,
  LocalTimestampFormat,
  type Stream,
  declaredFormat,
} from '@workspace/elt';

import { SQLiteColumn, type SQLiteColumnType } from './sqlite-column.ts';

function scalarType(
  name: string,
  type: string,
  format: DeclaredFormat | null,
): SQLiteColumnType {
  switch (type) {
    case 'string':
      return format ?? 'text';
    case 'integer':
      return 'integer';
    case 'number':
      return 'real';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      throw new TypeError(
        `Unsupported JSON Schema type for field ${name}: ${type}`,
      );
  }
}

// SQLite column declarations are independent of a source or connection.
export class SQLiteColumns {
  // Scalars, and arrays of scalars or of objects as JSON arrays in TEXT.
  // String formats keep their kind, as in Postgres.
  static fromSchema({
    properties,
    required = [],
  }: Stream['jsonSchema']): readonly SQLiteColumn[] {
    if (properties === undefined)
      throw new TypeError(
        'SQLite requires an object schema with explicit properties',
      );
    const requiredFields = new Set(required);
    for (const name of requiredFields)
      if (!Object.hasOwn(properties, name))
        throw new TypeError(`Schema does not describe field ${name}`);

    return Object.entries(properties).map(([name, field]) => {
      const types = typeof field.type === 'string' ? [field.type] : field.type;
      if (new Set(types).size !== types.length)
        throw new TypeError(`Unsupported JSON Schema type for field ${name}`);
      const valueTypes = types.filter((type) => type !== 'null');
      const valueType = valueTypes[0];
      if (valueType === undefined || valueTypes.length !== 1)
        throw new TypeError(
          `SQLite requires one scalar type for field ${name}`,
        );
      const array = valueType === 'array';
      const items = array ? field.items : undefined;
      if (array && items === undefined)
        throw new TypeError(`Unsupported JSON Schema items for field ${name}`);
      const format = declaredFormat(items ?? field);
      return new SQLiteColumn(
        name,
        scalarType(name, items?.type ?? valueType, format),
        {
          nullable: types.includes('null'),
          optional: !requiredFields.has(name),
          primaryKey: false,
          array,
        },
      );
    });
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
