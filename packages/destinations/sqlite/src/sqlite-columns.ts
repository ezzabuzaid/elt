import {
  type DeclaredFormat,
  type Stream,
  declaredFormat,
} from '@workspace/elt';

import { SQLiteColumn, formatKinds } from './sqlite-column.ts';

function scalarKind(
  name: string,
  type: string,
  format: DeclaredFormat | null,
): SQLiteColumn['kind'] {
  switch (type) {
    case 'string':
      return format === null ? 'text' : formatKinds[format.name];
    case 'integer':
      return 'integer';
    case 'number':
      return 'real';
    case 'boolean':
      return 'boolean';
    default:
      throw new TypeError(
        `Unsupported JSON Schema type for field ${name}: ${type}`,
      );
  }
}

// SQLite column declarations are independent of a source or connection.
export class SQLiteColumns {
  // Scalars, and arrays of scalars as JSON arrays in TEXT. String formats
  // keep their kind, as in Postgres.
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
        scalarKind(name, items?.type ?? valueType, format),
        {
          nullable: types.includes('null'),
          optional: !requiredFields.has(name),
          primaryKey: false,
          array,
          format: format ?? undefined,
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
