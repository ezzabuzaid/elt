import type { SQLInputValue } from 'node:sqlite';

import type {
  DeclaredFormat,
  DocumentParser,
  FileReference,
} from '@workspace/elt';
import { FileRead, isCalendarDate, isTimestamp } from '@workspace/elt';

// STRICT tables accept only these types, so dates and times are their
// canonical ISO text, which sorts in time order, and exact decimals are text.
const storageTypes = {
  text: 'TEXT',
  integer: 'INTEGER',
  int64: 'INTEGER',
  real: 'REAL',
  decimal: 'TEXT',
  blob: 'BLOB',
  boolean: 'INTEGER',
  date: 'TEXT',
  timestamp: 'TEXT',
  local_timestamp: 'TEXT',
  local_time: 'TEXT',
} as const;

type Kind = keyof typeof storageTypes;

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

// GLOB for a fraction of a second with exactly this many digits.
const fraction = (precision: number) =>
  precision === 0 ? '' : `.${'[0-9]'.repeat(precision)}`;

// Whether the first 19 characters name a real second of the calendar.
const realSecond = (name: string) =>
  `strftime('%Y-%m-%dT%H:%M:%S', substr(${name}, 1, 19)) IS substr(${name}, 1, 19)`;

// A CHECK that keeps a value of the kind in its canonical form.
export function canonical(
  kind: Kind,
  name: string,
  format?: DeclaredFormat,
): string {
  switch (kind) {
    case 'boolean':
      return ` CHECK (${name} IN (0, 1))`;
    case 'date':
      return ` CHECK (date(${name}) IS ${name})`;
    case 'timestamp': {
      const precision = format?.name === 'date-time' ? format.precision : 3;
      return precision === 3
        ? ` CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ${name}) IS ${name})`
        : ` CHECK (${realSecond(name)} AND substr(${name}, 20) GLOB '${fraction(precision)}Z')`;
    }
    case 'local_timestamp':
      return format?.name === 'date-time-local'
        ? ` CHECK (${realSecond(name)} AND substr(${name}, 20) GLOB '${fraction(format.precision)}')`
        : '';
    case 'local_time':
      return format?.name === 'time-local'
        ? ` CHECK (time(substr(${name}, 1, 8)) IS substr(${name}, 1, 8) AND substr(${name}, 9) GLOB '${fraction(format.precision)}')`
        : '';
    default:
      return '';
  }
}

export class SQLiteColumn {
  // The record field the column holds.
  readonly field: string;
  // What SQLite calls the column, which the table it belongs to decides.
  readonly name: string;
  readonly kind: Kind;
  // The string format a schema-inferred column keeps, which refines its kind.
  readonly format?: DeclaredFormat;
  readonly required: boolean;
  readonly isPrimaryKey: boolean;
  readonly nullable: boolean;
  readonly optional: boolean;
  // An array of kind, stored as a JSON array in TEXT.
  readonly array: boolean;
  readonly fileRead?: FileRead;

  constructor(
    field: string,
    kind: Kind,
    options: {
      nullable: boolean;
      optional: boolean;
      primaryKey: boolean;
      array?: boolean;
      fileRead?: FileRead;
      format?: DeclaredFormat;
      name?: string;
    },
  ) {
    if (typeof field !== 'string')
      throw new TypeError('A column holds a field named by a string');
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError('Unsupported SQLite column type');
    const { format } = options;
    if (
      format === undefined
        ? formatted.has(kind)
        : formatKinds[format.name] !== kind
    )
      throw new TypeError(`Column ${field} kind ${kind} must match its format`);
    this.format = format;
    this.array = options.array ?? false;
    if (this.array && (kind === 'blob' || options.primaryKey))
      throw new TypeError(
        'Array columns hold scalar values and cannot be keys',
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
    this.required = !this.nullable && !this.optional;
    Object.freeze(this);
  }

  primaryKey(): SQLiteColumn {
    return new SQLiteColumn(this.field, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: true,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
      name: this.name,
    });
  }

  notNull(): SQLiteColumn {
    return new SQLiteColumn(this.field, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
      name: this.name,
    });
  }

  from(file: FileReference): SQLiteColumn {
    if (this.array || (this.kind !== 'blob' && this.kind !== 'text'))
      throw new TypeError(
        'Files require a BLOB column, parsed TEXT or a stored TEXT reference',
      );
    return new SQLiteColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.field, file, this.fileRead?.parser),
      name: this.name,
    });
  }

  parse(parser: DocumentParser): SQLiteColumn {
    if (this.kind !== 'text')
      throw new TypeError('Document parsing requires a TEXT column');
    if (this.fileRead === undefined)
      throw new TypeError('Select a source file before selecting a parser');
    return new SQLiteColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.field, this.fileRead.file, parser),
      name: this.name,
    });
  }

  // This column as the table names it.
  named(name: string): SQLiteColumn {
    return new SQLiteColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
      name,
    });
  }

  get quotedName(): string {
    return `"${this.name.replaceAll('"', '""')}"`;
  }

  // Original file bytes live in a chunk table; the column keeps the file's id.
  get storesFile(): boolean {
    return this.kind === 'blob' && this.fileRead !== undefined;
  }

  get storageType(): string {
    if (this.array) return 'TEXT';
    return this.storesFile ? 'INTEGER' : storageTypes[this.kind];
  }

  // The column's type as readers see it in the catalog.
  get dataType(): string {
    if (this.storesFile) return 'integer';
    return this.array ? `${this.#typeName}[]` : this.#typeName;
  }

  // The kind with the precision and scale its format declares, as SQL writes
  // them; a timestamp of milliseconds is the plain kind.
  get #typeName(): string {
    const { format } = this;
    switch (format?.name) {
      case 'date-time':
        return format.precision === 3
          ? this.kind
          : `${this.kind}(${format.precision})`;
      case 'date-time-local':
      case 'time-local':
        return `${this.kind}(${format.precision})`;
      case 'decimal':
        return format.precision === undefined
          ? this.kind
          : `${this.kind}(${[format.precision, format.scale ?? []].join(',')})`;
      default:
        return this.kind;
    }
  }

  get definition(): string {
    const check = this.array
      ? ` CHECK (json_valid(${this.quotedName}) AND json_type(${this.quotedName}) = 'array')`
      : canonical(this.kind, this.quotedName, this.format);
    return `${this.quotedName} ${this.storageType}${this.isPrimaryKey ? ' PRIMARY KEY' : ''}${this.required ? ' NOT NULL' : ''}${check}`;
  }

  encode(record: unknown): SQLInputValue {
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
    const { format } = this;
    if (this.array) {
      if (
        Array.isArray(value) &&
        value.every((element) => this.#element(element))
      )
        return JSON.stringify(value);
      throw new TypeError(
        `Field ${JSON.stringify(this.field)} requires an array of ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
      );
    }
    if (format !== undefined) {
      if (typeof value === 'string' && format.accepts(value)) {
        if (format.name === 'int64') return BigInt(value);
        if (format.name === 'base64') return Buffer.from(value, 'base64');
        return value;
      }
      throw new TypeError(
        `Field ${JSON.stringify(this.field)} requires a canonical ${format.name} value${this.nullable ? ' or null' : ' (not null)'}`,
      );
    }
    switch (this.kind) {
      case 'text':
        if (typeof value === 'string') return value;
        break;
      case 'boolean':
        if (typeof value === 'boolean') return Number(value);
        break;
      case 'integer':
        if (
          (typeof value === 'bigint' &&
            value >= -(2n ** 63n) &&
            value < 2n ** 63n) ||
          (typeof value === 'number' && Number.isSafeInteger(value))
        )
          return value;
        break;
      case 'date':
        if (isCalendarDate(value)) return value;
        break;
      case 'timestamp':
        if (isTimestamp(value)) return value;
        break;
      case 'real':
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        break;
      case 'blob':
        if (this.storesFile) {
          if (typeof value === 'number' && Number.isSafeInteger(value))
            return value;
        } else if (value instanceof Uint8Array) return value;
    }
    throw new TypeError(
      `Field ${JSON.stringify(this.field)} requires ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
    );
  }

  // Whether a JSON array element keeps this kind's value exactly.
  #element(value: unknown): boolean {
    if (this.format !== undefined)
      return typeof value === 'string' && this.format.accepts(value);
    switch (this.kind) {
      case 'text':
        return typeof value === 'string';
      case 'boolean':
        return typeof value === 'boolean';
      case 'integer':
        return Number.isSafeInteger(value);
      case 'real':
        return typeof value === 'number' && Number.isFinite(value);
      case 'date':
        return isCalendarDate(value);
      case 'timestamp':
        return isTimestamp(value);
      default:
        return false;
    }
  }
}
