import { type DeclaredFormat, type Stream, declaredFormat } from '@eltjs/elt';

import { PostgresColumn, type PostgresColumnType } from './postgres-column.ts';

function scalarType(
  name: string,
  type: string,
  format: DeclaredFormat | null,
): PostgresColumnType {
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

// Postgres column declarations are independent of a source or connection.
export class PostgresColumns {
  // Scalars and arrays of scalars. Unlike SQLite, the string formats get their
  // own types, so readers can do date arithmetic without parsing text, and an
  // array is a native array of its item type.
  static fromSchema({
    properties,
    required = [],
  }: Stream['jsonSchema']): readonly PostgresColumn[] {
    if (properties === undefined)
      throw new TypeError(
        'Postgres requires an object schema with explicit properties',
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
          `Postgres requires one scalar type for field ${name}`,
        );
      const array = valueType === 'array';
      const items = array ? field.items : undefined;
      if (array && items === undefined)
        throw new TypeError(`Unsupported JSON Schema items for field ${name}`);
      const format = declaredFormat(items ?? field);
      return new PostgresColumn(
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
