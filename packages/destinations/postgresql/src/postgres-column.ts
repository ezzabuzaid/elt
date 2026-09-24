import { isCalendarDate, isTimestamp } from 'elt';
import { identifier, quote } from './identifier.ts';

const storageTypes = {
  text: 'TEXT',
  integer: 'BIGINT',
  real: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMPTZ',
} as const;

// information_schema.columns.data_type for each storage type.
const dataTypes = {
  text: 'text',
  integer: 'bigint',
  real: 'double precision',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamp with time zone',
} as const;

// A value the batch insert can carry through JSON and cast back to the column type.
export type EncodedValue = string | number | boolean | null;

export class PostgresColumn {
  readonly name: string;
  readonly kind: keyof typeof storageTypes;
  readonly required: boolean;
  readonly isPrimaryKey: boolean;
  readonly nullable: boolean;
  readonly optional: boolean;

  constructor(
    name: string,
    kind: keyof typeof storageTypes,
    options: { nullable: boolean; optional: boolean; primaryKey: boolean },
  ) {
    identifier(name, 'column name');
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError('Unsupported Postgres column type');
    this.name = name;
    this.kind = kind;
    this.isPrimaryKey = options.primaryKey;
    this.nullable = !options.primaryKey && options.nullable;
    this.optional = !options.primaryKey && options.optional;
    this.required = !this.nullable && !this.optional;
    Object.freeze(this);
  }

  primaryKey(): PostgresColumn {
    return new PostgresColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: true,
    });
  }

  notNull(): PostgresColumn {
    return new PostgresColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
    });
  }

  get quotedName(): string {
    return quote(this.name);
  }

  get storageType(): string {
    return storageTypes[this.kind];
  }

  get dataType(): string {
    return dataTypes[this.kind];
  }

  get definition(): string {
    return `${this.quotedName} ${this.storageType}${this.isPrimaryKey ? ' PRIMARY KEY' : ''}${this.required ? ' NOT NULL' : ''}`;
  }

  encode(record: unknown): EncodedValue {
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw new TypeError(`Record is missing column "${this.name}"`);
    if (!Object.hasOwn(record, this.name)) {
      if (this.optional) return null;
      throw new TypeError(`Record is missing column "${this.name}"`);
    }
    const value: unknown = Reflect.get(record, this.name);
    if (value === null && this.nullable) return null;
    switch (this.kind) {
      case 'text':
        if (typeof value === 'string' && !value.includes('\0')) return value;
        break;
      case 'boolean':
        if (typeof value === 'boolean') return value;
        break;
      case 'integer':
        if (
          typeof value === 'bigint' &&
          value >= -(2n ** 63n) &&
          value < 2n ** 63n
        )
          return String(value);
        if (typeof value === 'number' && Number.isSafeInteger(value))
          return value;
        break;
      case 'real':
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        break;
      case 'date':
        if (isCalendarDate(value)) return value;
        break;
      case 'timestamp':
        if (isTimestamp(value)) return value;
    }
    throw new TypeError(
      `Column "${this.name}" requires ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
    );
  }
}
