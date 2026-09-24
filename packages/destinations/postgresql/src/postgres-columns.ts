import type { Stream } from 'elt';
import { PostgresColumn } from './postgres-column.ts';

// Postgres column declarations are independent of a source or connection.
export class PostgresColumns {
  // Flat scalar schemas only. Unlike SQLite, the string formats get their own
  // types, so readers can do date arithmetic without parsing text.
  static fromSchema(schema: Stream['jsonSchema']): readonly PostgresColumn[] {
    const { properties, required } = schema;
    if (
      schema.type !== 'object' ||
      properties === null ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      throw new TypeError(
        'Postgres requires an object schema with explicit properties',
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
            `Postgres requires one scalar type for field ${name}`,
          );
        const format: unknown = Reflect.get(field, 'format');
        let kind: PostgresColumn['kind'];
        switch (scalarTypes[0]) {
          case 'string':
            kind =
              format === 'date'
                ? 'date'
                : format === 'date-time'
                  ? 'timestamp'
                  : 'text';
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
        return new PostgresColumn(name, kind, {
          nullable: types.includes('null'),
          optional: !requiredFields.has(name),
          primaryKey: false,
        });
      },
    );
  }

  text(field: string): PostgresColumn {
    return this.#column(field, 'text');
  }

  integer(field: string): PostgresColumn {
    return this.#column(field, 'integer');
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

  #column(field: string, kind: PostgresColumn['kind']): PostgresColumn {
    return new PostgresColumn(field, kind, {
      nullable: true,
      optional: false,
      primaryKey: false,
    });
  }
}
