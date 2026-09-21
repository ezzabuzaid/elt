import type { SQLInputValue } from 'node:sqlite';
import type { DocumentParser } from '../../core/document-parser.ts';
import { FileRead, type FileReference } from '../../core/file-read.ts';

const storageTypes = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  blob: 'BLOB',
  boolean: 'INTEGER',
} as const;

export class SQLiteColumn {
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
    if (!name || name.includes('\0'))
      throw new TypeError('Invalid column name');
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError('Unsupported SQLite column type');
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

  primaryKey(): SQLiteColumn {
    return new SQLiteColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: true,
      fileRead: this.fileRead,
    });
  }

  notNull(): SQLiteColumn {
    return new SQLiteColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      fileRead: this.fileRead,
    });
  }

  from(file: FileReference): SQLiteColumn {
    if (this.kind !== 'blob' && this.kind !== 'text')
      throw new TypeError('Files require a BLOB column or parsed TEXT column');
    return new SQLiteColumn(this.name, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.name, file, this.fileRead?.parser),
    });
  }

  parse(parser: DocumentParser): SQLiteColumn {
    if (this.kind !== 'text')
      throw new TypeError('Document parsing requires a TEXT column');
    if (this.fileRead === undefined)
      throw new TypeError('Select a source file before selecting a parser');
    return new SQLiteColumn(this.name, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.name, this.fileRead.file, parser),
    });
  }

  get quotedName(): string {
    return `"${this.name.replaceAll('"', '""')}"`;
  }

  get storageType(): string {
    return storageTypes[this.kind];
  }

  get definition(): string {
    return `${this.quotedName} ${this.storageType}${this.isPrimaryKey ? ' PRIMARY KEY' : ''}${this.required ? ' NOT NULL' : ''}${this.kind === 'boolean' ? ` CHECK (${this.quotedName} IN (0, 1))` : ''}`;
  }

  encode(record: unknown): SQLInputValue {
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
        if (typeof value === 'string') return value;
        break;
      case 'boolean':
        if (typeof value === 'boolean') return Number(value);
        break;
      case 'integer':
        if (
          typeof value === 'bigint' ||
          (typeof value === 'number' && Number.isSafeInteger(value))
        )
          return value;
        break;
      case 'real':
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        break;
      case 'blob':
        if (value instanceof Uint8Array) return value;
    }
    throw new TypeError(
      `Column "${this.name}" requires ${this.kind}${this.nullable ? ' or null' : ' (not null)'}`,
    );
  }
}
