import type { Stream } from '../../core/stream.ts';
import { SQLiteColumn } from './sqlite-column.ts';

// SQLite column declarations are independent of a source or connection.
export class SQLiteColumns {
  // ponytail: flat scalar schemas only; add nested mapping when a source requires it.
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
        const scalarTypes = types.filter((value) => value !== 'null');
        if (scalarTypes.length !== 1)
          throw new TypeError(
            `SQLite requires one scalar type for field ${name}`,
          );
        let kind: SQLiteColumn['kind'];
        switch (scalarTypes[0]) {
          case 'string':
            kind = 'text';
            break;
          case 'integer':
            kind = 'integer';
            break;
          case 'number':
            kind = 'real';
            break;
          case 'boolean':
            kind = 'boolean';
            break;
          default:
            throw new TypeError(
              `Unsupported JSON Schema type for field ${name}: ${scalarTypes[0]}`,
            );
        }
        return new SQLiteColumn(name, kind, {
          nullable: types.includes('null'),
          optional: !requiredFields.has(name),
          primaryKey: false,
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
