import type { Stream } from 'elt';
import { SQLiteColumn } from './sqlite-column.ts';

function scalarKind(
  name: string,
  type: unknown,
  format: unknown,
): SQLiteColumn['kind'] {
  switch (type) {
    case 'string':
      return format === 'date'
        ? 'date'
        : format === 'date-time'
          ? 'timestamp'
          : 'text';
    case 'integer':
      return 'integer';
    case 'number':
      return 'real';
    case 'boolean':
      return 'boolean';
    default:
      throw new TypeError(
        `Unsupported JSON Schema type for field ${name}: ${String(type)}`,
      );
  }
}

// SQLite column declarations are independent of a source or connection.
export class SQLiteColumns {
  // Scalars, and arrays of scalars as JSON arrays in TEXT. The date and
  // date-time string formats keep their kind, as in Postgres.
  static fromSchema(schema: Stream['jsonSchema']): readonly SQLiteColumn[] {
    const { properties, required } = schema;
    if (
      schema.type !== 'object' ||
      properties === null ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      throw new TypeError(
        'SQLite requires an object schema with explicit properties',
      );
    if (
      required !== undefined &&
      (!Array.isArray(required) ||
        !required.every((name) => typeof name === 'string'))
    )
      throw new TypeError(
        'JSON Schema required must be an array of field names',
      );
    // JSON Schema defines omitted required as no required properties.
    const requiredFields = new Set<string>(required);
    for (const name of requiredFields)
      if (!Object.hasOwn(properties, name))
        throw new TypeError(`Schema does not describe field ${name}`);

    return Object.entries(properties).map(
      ([name, field]: [string, unknown]) => {
        if (field === null || typeof field !== 'object' || Array.isArray(field))
          throw new TypeError(`Unsupported JSON Schema for field ${name}`);
        const type: unknown = Reflect.get(field, 'type');
        const types = typeof type === 'string' ? [type] : type;
        if (
          !Array.isArray(types) ||
          !types.every((value) => typeof value === 'string') ||
          new Set(types).size !== types.length
        )
          throw new TypeError(`Unsupported JSON Schema type for field ${name}`);
        const valueTypes = types.filter((value) => value !== 'null');
        if (valueTypes.length !== 1)
          throw new TypeError(
            `SQLite requires one scalar type for field ${name}`,
          );
        const array = valueTypes[0] === 'array';
        const items: unknown = array ? Reflect.get(field, 'items') : field;
        if (items === null || typeof items !== 'object' || Array.isArray(items))
          throw new TypeError(
            `Unsupported JSON Schema items for field ${name}`,
          );
        const kind = scalarKind(
          name,
          array ? Reflect.get(items, 'type') : valueTypes[0],
          Reflect.get(items, 'format'),
        );
        return new SQLiteColumn(name, kind, {
          nullable: types.includes('null'),
          optional: !requiredFields.has(name),
          primaryKey: false,
          array,
        });
      },
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
