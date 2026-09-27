import {
  type DocumentParser,
  FileRead,
  type FileReference,
  isCalendarDate,
  isTimestamp,
} from 'elt';
import { identifier, quote } from './identifier.ts';

const storageTypes = {
  text: 'TEXT',
  integer: 'BIGINT',
  real: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  date: 'DATE',
  timestamp: 'TIMESTAMPTZ',
  blob: 'BYTEA',
} as const;

// information_schema.columns.data_type for each storage type.
const dataTypes = {
  text: 'text',
  integer: 'bigint',
  real: 'double precision',
  boolean: 'boolean',
  date: 'date',
  timestamp: 'timestamp with time zone',
  blob: 'bytea',
} as const;

// A value the batch insert can carry through JSON and cast back to the column type.
export type EncodedValue = string | number | boolean | null;

// ISO years count astronomically, so year 0000 is 1 BC, which Postgres spells
// as year 0001 with a BC suffix; every other year reads the same in both.
function postgresYear(value: string): string {
  return value.startsWith('0000-') ? `0001${value.slice(4)} BC` : value;
}

export class PostgresColumn {
  readonly name: string;
  readonly kind: keyof typeof storageTypes;
  readonly required: boolean;
  readonly isPrimaryKey: boolean;
  readonly nullable: boolean;
  readonly optional: boolean;
  readonly fileRead?: FileRead;

  constructor(
    name: string,
    kind: keyof typeof storageTypes,
    options: {
      nullable: boolean;
      optional: boolean;
      primaryKey: boolean;
      fileRead?: FileRead;
    },
  ) {
    identifier(name, 'column name');
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError('Unsupported Postgres column type');
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
      fileRead: this.fileRead,
    });
  }

  notNull(): PostgresColumn {
    return new PostgresColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      fileRead: this.fileRead,
    });
  }

  from(file: FileReference): PostgresColumn {
    if (this.kind !== 'blob' && this.kind !== 'text')
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

  get storageType(): string {
    return this.storesFile ? 'UUID' : storageTypes[this.kind];
  }

  get dataType(): string {
    return this.storesFile ? 'uuid' : dataTypes[this.kind];
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
    throw new TypeError(
      `Column "${this.name}" requires ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
    );
  }
}
