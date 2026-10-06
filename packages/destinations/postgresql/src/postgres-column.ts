import {
  type DeclaredFormat,
  type DocumentParser,
  FileRead,
  type FileReference,
  isCalendarDate,
  isTimestamp,
} from '@workspace/elt';

import { identifier, quote } from './identifier.ts';

const storageTypes = {
  text: 'TEXT',
  integer: 'BIGINT',
  int64: 'BIGINT',
  real: 'DOUBLE PRECISION',
  decimal: 'NUMERIC',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMPTZ',
  local_timestamp: 'TIMESTAMP',
  local_time: 'TIME',
  blob: 'BYTEA',
} as const;

type Kind = keyof typeof storageTypes;

// information_schema.columns.data_type for each storage type.
const dataTypes = {
  text: 'text',
  integer: 'bigint',
  int64: 'bigint',
  real: 'double precision',
  decimal: 'numeric',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamp with time zone',
  local_timestamp: 'timestamp without time zone',
  local_time: 'time without time zone',
  blob: 'bytea',
} as const satisfies Record<Kind, string>;

// The kind that stores each string format; base64 text loads as its bytes.
export const formatKinds = {
  'date-time': 'timestamp',
  date: 'date',
  'date-time-local': 'local_timestamp',
  'time-local': 'local_time',
  int64: 'int64',
  decimal: 'decimal',
  base64: 'blob',
} as const satisfies Record<DeclaredFormat['name'], Kind>;

const formatted = new Set<Kind>([
  'int64',
  'decimal',
  'local_timestamp',
  'local_time',
]);

// Postgres keeps time to the microsecond.
const finestPrecision = 6;

// A value the batch insert can carry through JSON and cast back to the column type.
export type EncodedValue =
  string | number | boolean | null | readonly (string | number | boolean)[];

// ISO years count astronomically, so year 0000 is 1 BC, which Postgres spells
// as year 0001 with a BC suffix; every other year reads the same in both.
function postgresYear(value: string): string {
  return value.startsWith('0000-') ? `0001${value.slice(4)} BC` : value;
}

export class PostgresColumn {
  readonly name: string;
  readonly kind: Kind;
  // The string format a schema-inferred column keeps, which refines its kind.
  readonly format?: DeclaredFormat;
  readonly required: boolean;
  readonly isPrimaryKey: boolean;
  readonly nullable: boolean;
  readonly optional: boolean;
  // An array of kind, stored as a native Postgres array of that type.
  readonly array: boolean;
  readonly fileRead?: FileRead;

  constructor(
    name: string,
    kind: Kind,
    options: {
      nullable: boolean;
      optional: boolean;
      primaryKey: boolean;
      array?: boolean;
      fileRead?: FileRead;
      format?: DeclaredFormat;
    },
  ) {
    identifier(name, 'column name');
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError('Unsupported Postgres column type');
    const { format } = options;
    if (
      format === undefined
        ? formatted.has(kind)
        : formatKinds[format.name] !== kind
    )
      throw new TypeError(`Column ${name} kind ${kind} must match its format`);
    this.format = format;
    this.array = options.array ?? false;
    if (this.array && (kind === 'blob' || options.primaryKey))
      throw new TypeError(
        'Array columns hold scalar values and cannot be keys',
      );
    this.fileRead = options.fileRead;
    if (
      this.fileRead !== undefined &&
      (!(this.fileRead instanceof FileRead) || this.fileRead.name !== name)
    )
      throw new TypeError('Column file read must match its name');
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
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
    });
  }

  notNull(): PostgresColumn {
    return new PostgresColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
    });
  }

  from(file: FileReference): PostgresColumn {
    if (this.array || (this.kind !== 'blob' && this.kind !== 'text'))
      throw new TypeError(
        'Files require a BLOB column, parsed TEXT or a stored TEXT reference',
      );
    return new PostgresColumn(this.name, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.name, file, this.fileRead?.parser),
    });
  }

  parse(parser: DocumentParser): PostgresColumn {
    if (this.kind !== 'text')
      throw new TypeError('Document parsing requires a TEXT column');
    if (this.fileRead === undefined)
      throw new TypeError('Select a source file before selecting a parser');
    return new PostgresColumn(this.name, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.name, this.fileRead.file, parser),
    });
  }

  get storesFile(): boolean {
    return this.kind === 'blob' && this.fileRead !== undefined;
  }

  get quotedName(): string {
    return quote(this.name);
  }

  // A time finer than microseconds keeps its exact text, which sorts in time
  // order under the "C" collation, since its values share one width.
  get #exactText(): boolean {
    const { format } = this;
    return (
      (format?.name === 'date-time' ||
        format?.name === 'date-time-local' ||
        format?.name === 'time-local') &&
      format.precision > finestPrecision
    );
  }

  // The type of one value, with the precision and scale a decimal declares.
  get #scalarType(): string {
    const { format } = this;
    if (this.#exactText) return 'TEXT';
    if (format?.name === 'decimal' && format.precision !== undefined)
      return `NUMERIC(${[format.precision, format.scale ?? []].join(', ')})`;
    return storageTypes[this.kind];
  }

  get storageType(): string {
    if (this.storesFile) return 'UUID';
    return `${this.#scalarType}${this.array ? '[]' : ''}`;
  }

  get dataType(): string {
    if (this.storesFile) return 'uuid';
    if (this.array) return 'ARRAY';
    return this.#exactText ? 'text' : dataTypes[this.kind];
  }

  // This column's value read back from element index of a JSON batch row. An
  // array's elements are cast one by one, in order; a JSON null stays NULL.
  valueFrom(row: string, index: number): string {
    if (!this.array) return `(${row}->>${index})::${this.storageType}`;
    return `CASE WHEN json_typeof(${row}->${index}) = 'array' THEN ARRAY(SELECT element.value::${this.#scalarType} FROM json_array_elements_text(${row}->${index}) WITH ORDINALITY AS element (value, position) ORDER BY element.position) END`;
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
    if (this.array) {
      if (Array.isArray(value)) {
        const elements = value.map((element) => this.#scalar(element));
        if (elements.every((element) => element !== undefined)) return elements;
      }
      throw new TypeError(
        `Column "${this.name}" requires an array of ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
      );
    }
    const encoded = this.#scalar(value);
    if (encoded !== undefined) return encoded;
    throw new TypeError(
      `Column "${this.name}" requires ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
    );
  }

  // One scalar in its batch encoding, or undefined when the kind rejects it.
  #scalar(value: unknown): string | number | boolean | undefined {
    const { format } = this;
    if (format !== undefined) {
      if (typeof value !== 'string' || !format.accepts(value)) return undefined;
      switch (format.name) {
        case 'base64':
          return `\\x${Buffer.from(value, 'base64').toString('hex')}`;
        case 'date':
        case 'date-time':
        case 'date-time-local':
          return this.#exactText ? value : postgresYear(value);
        default:
          return value;
      }
    }
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
        if (isCalendarDate(value)) return postgresYear(value);
        break;
      case 'timestamp':
        if (isTimestamp(value)) return postgresYear(value);
        break;
      case 'blob':
        if (this.storesFile) {
          if (
            typeof value === 'string' &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
          )
            return value;
        } else if (value instanceof Uint8Array)
          return `\\x${Buffer.from(value).toString('hex')}`;
    }
    return undefined;
  }
}
