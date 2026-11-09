import {
  type DeclaredFormat,
  type DocumentParser,
  FileRead,
  type FileReference,
  isCalendarDate,
  isTimestamp,
} from '@eltjs/elt';

import { quote } from './identifier.ts';

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
  // An object of scalar fields, only as an item of an array column.
  object: 'JSONB',
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
  object: 'jsonb',
} as const satisfies Record<Kind, string>;

// The kind that stores each string format; base64 text loads as its bytes.
const formatKinds = {
  'date-time': 'timestamp',
  date: 'date',
  'date-time-local': 'local_timestamp',
  'time-local': 'local_time',
  int64: 'int64',
  decimal: 'decimal',
  base64: 'blob',
} as const satisfies Record<DeclaredFormat['name'], Kind>;

// The kinds a column holds without a format. The other kinds hold text that
// only a format can check, so a column gets them from its format.
type PlainKind =
  | 'text'
  | 'integer'
  | 'real'
  | 'blob'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'object';
const plainKinds: ReadonlySet<string> = new Set<PlainKind>([
  'text',
  'integer',
  'real',
  'blob',
  'boolean',
  'date',
  'timestamp',
  'object',
]);

// What a column holds: a kind of its own, or a string format, which decides
// the kind.
export type PostgresColumnType = PlainKind | DeclaredFormat;

// Postgres keeps time to the microsecond.
const finestPrecision = 6;

// An object item of an array column: its scalar fields.
type EncodedObject = Readonly<Record<string, string | number | boolean | null>>;

// A value the batch insert can carry through JSON and cast back to the column type.
export type EncodedValue =
  | string
  | number
  | boolean
  | null
  | readonly (string | number | boolean | EncodedObject)[];

// ISO years count astronomically, so year 0000 is 1 BC, which Postgres spells
// as year 0001 with a BC suffix; every other year reads the same in both.
function postgresYear(value: string): string {
  return value.startsWith('0000-') ? `0001${value.slice(4)} BC` : value;
}

export class PostgresColumn {
  // The record field the column holds.
  readonly field: string;
  // What Postgres calls the column, which the table it belongs to decides.
  readonly name: string;
  readonly type: PostgresColumnType;
  readonly kind: Kind;
  readonly isPrimaryKey: boolean;
  readonly nullable: boolean;
  readonly optional: boolean;
  // An array of kind, stored as a native Postgres array of that type.
  readonly array: boolean;
  readonly fileRead?: FileRead;

  constructor(
    field: string,
    type: PostgresColumnType,
    options: {
      nullable: boolean;
      optional: boolean;
      primaryKey: boolean;
      array?: boolean;
      fileRead?: FileRead;
      name?: string;
    },
  ) {
    if (typeof field !== 'string')
      throw new TypeError('A column holds a field named by a string');
    if (typeof type === 'string' && !plainKinds.has(type))
      throw new TypeError('Unsupported Postgres column type');
    this.type = type;
    const kind = typeof type === 'string' ? type : formatKinds[type.name];
    this.array = options.array ?? false;
    if (this.array && (kind === 'blob' || options.primaryKey))
      throw new TypeError(
        'Array columns hold scalar values or objects and cannot be keys',
      );
    this.fileRead = options.fileRead;
    if (
      this.fileRead !== undefined &&
      (!(this.fileRead instanceof FileRead) || this.fileRead.name !== field)
    )
      throw new TypeError('Column file read must match its field');
    this.field = field;
    this.name = options.name ?? field;
    this.kind = kind;
    this.isPrimaryKey = options.primaryKey;
    this.nullable = !options.primaryKey && options.nullable;
    this.optional = !options.primaryKey && options.optional;
    Object.freeze(this);
  }

  primaryKey(): PostgresColumn {
    return new PostgresColumn(this.field, this.type, {
      nullable: false,
      optional: false,
      primaryKey: true,
      array: this.array,
      fileRead: this.fileRead,
      name: this.name,
    });
  }

  notNull(): PostgresColumn {
    return new PostgresColumn(this.field, this.type, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      name: this.name,
    });
  }

  from(file: FileReference): PostgresColumn {
    if (this.array || (this.kind !== 'blob' && this.kind !== 'text'))
      throw new TypeError(
        'Files require a BLOB column, parsed TEXT or a stored TEXT reference',
      );
    return new PostgresColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.field, file, this.fileRead?.parser),
      name: this.name,
    });
  }

  parse(parser: DocumentParser): PostgresColumn {
    if (this.kind !== 'text')
      throw new TypeError('Document parsing requires a TEXT column');
    if (this.fileRead === undefined)
      throw new TypeError('Select a source file before selecting a parser');
    return new PostgresColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.field, this.fileRead.file, parser),
      name: this.name,
    });
  }

  // This column as the table names it.
  named(name: string): PostgresColumn {
    return new PostgresColumn(this.field, this.type, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      name,
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
    const { type } = this;
    return (
      typeof type !== 'string' &&
      (type.name === 'date-time' ||
        type.name === 'date-time-local' ||
        type.name === 'time-local') &&
      type.precision > finestPrecision
    );
  }

  // The type of one value, with the precision and scale a decimal declares.
  get #scalarType(): string {
    const { type } = this;
    if (this.#exactText) return 'TEXT';
    if (
      typeof type !== 'string' &&
      type.name === 'decimal' &&
      type.precision !== undefined
    )
      return `NUMERIC(${[type.precision, type.scale ?? []].join(', ')})`;
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

  // A field the stream requires stays nullable in storage: rows loaded before
  // it was added have no value for it. Records are still checked for it when
  // they are written (encode).
  get definition(): string {
    return `${this.quotedName} ${this.storageType}${this.isPrimaryKey ? ' PRIMARY KEY' : ''}`;
  }

  encode(record: unknown): EncodedValue {
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw new TypeError(
        `Record is missing field ${JSON.stringify(this.field)}`,
      );
    if (!Object.hasOwn(record, this.field)) {
      if (this.optional) return null;
      throw new TypeError(
        `Record is missing field ${JSON.stringify(this.field)}`,
      );
    }
    const value: unknown = Reflect.get(record, this.field);
    if (value === null && this.nullable) return null;
    if (this.array) {
      if (Array.isArray(value)) {
        const elements = value.map((element) => this.#element(element));
        if (elements.every((element) => element !== undefined)) return elements;
      }
      throw new TypeError(
        `Field ${JSON.stringify(this.field)} requires an array of ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
      );
    }
    const encoded = this.#scalar(value);
    if (encoded !== undefined) return encoded;
    throw new TypeError(
      `Field ${JSON.stringify(this.field)} requires ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
    );
  }

  // One element of an array in its batch encoding: an object item as its
  // fields, any other as its scalar; undefined when the kind rejects it.
  #element(
    value: unknown,
  ): string | number | boolean | EncodedObject | undefined {
    if (this.kind !== 'object') return this.#scalar(value);
    // jsonb holds no NUL character, as text holds none.
    return value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).every(
        (field) =>
          field === null ||
          (typeof field === 'string' && !field.includes('\0')) ||
          typeof field === 'boolean' ||
          (typeof field === 'number' && Number.isFinite(field)),
      )
      ? Object.fromEntries(Object.entries(value))
      : undefined;
  }

  // One scalar in its batch encoding, or undefined when the kind rejects it.
  #scalar(value: unknown): string | number | boolean | undefined {
    const { type } = this;
    if (typeof type !== 'string') {
      if (typeof value !== 'string' || !type.accepts(value)) return undefined;
      switch (type.name) {
        case 'base64':
          return `\\x${Buffer.from(value, 'base64').toHex()}`;
        case 'date':
        case 'date-time':
        case 'date-time-local':
          return this.#exactText ? value : postgresYear(value);
        default:
          return value;
      }
    }
    switch (type) {
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
        } else if (value instanceof Uint8Array) return `\\x${value.toHex()}`;
        break;
      // An object is only an array's item, which #element encodes.
      case 'object':
    }
    return undefined;
  }
}
