import {
  type DeclaredFormat,
  declaredFormat,
} from './formats/declared-format.ts';
import type { Stream } from './stream.ts';

// The selected logical identity and ordering rule, independent of storage constraints.
export class Deduplication {
  readonly stream: Stream;
  readonly primaryKey: readonly string[];
  // Absent when the newest extraction always wins (dedupPolicy replace).
  readonly cursorField?: string;
  readonly #formats = new Map<string, DeclaredFormat | null>();

  constructor(
    stream: Stream,
    primaryKey: readonly string[],
    cursorField?: string,
  ) {
    this.stream = stream;
    this.cursorField = cursorField;
    if (
      !Array.isArray(primaryKey) ||
      primaryKey.length === 0 ||
      new Set(primaryKey).size !== primaryKey.length
    )
      throw new TypeError('Deduplication requires distinct primaryKey fields');
    this.primaryKey = Object.freeze([...primaryKey]);
    for (const field of this.primaryKey) this.#declare(field);
    if (cursorField !== undefined) {
      if (!['string', 'number', 'integer'].includes(this.type(cursorField)))
        throw new TypeError('Deduplication cursor must be text or numeric');
      const format = this.#declare(cursorField);
      if (format?.orderable === false)
        throw new TypeError(
          `Deduplication cursor ${cursorField} cannot order ${format.name} values`,
        );
    }
    Object.freeze(this);
  }

  #declare(field: string): DeclaredFormat | null {
    this.type(field);
    const schema = this.stream.jsonSchema.properties?.[field];
    const format = schema === undefined ? null : declaredFormat(schema);
    this.#formats.set(field, format);
    return format;
  }

  // The format of a key or cursor field, null when it declares none.
  format(field: string): DeclaredFormat | null {
    const format = this.#formats.get(field);
    if (format === undefined)
      throw new TypeError(`${field} is not a key or cursor field`);
    return format;
  }

  type(field: string): 'string' | 'number' | 'integer' | 'boolean' {
    const properties = this.stream.jsonSchema.properties;
    if (
      typeof field !== 'string' ||
      !field ||
      properties === null ||
      typeof properties !== 'object' ||
      !Object.hasOwn(properties, field)
    )
      throw new TypeError(`Schema must describe key/cursor field ${field}`);
    const schema: unknown = Reflect.get(properties, field);
    const type: unknown =
      schema !== null && typeof schema === 'object'
        ? Reflect.get(schema, 'type')
        : undefined;
    if (
      type !== 'string' &&
      type !== 'number' &&
      type !== 'integer' &&
      type !== 'boolean'
    )
      throw new TypeError(
        `Key/cursor field ${field} requires one non-null scalar schema type`,
      );
    return type;
  }

  value(record: unknown, field: string): string | number | boolean {
    if (
      record === null ||
      typeof record !== 'object' ||
      !Object.hasOwn(record, field)
    )
      throw new TypeError(`Record is missing key/cursor field ${field}`);
    const value: unknown = Reflect.get(record, field);
    const type = this.type(field);
    const format = this.format(field);
    if (
      (type === 'string' &&
        typeof value === 'string' &&
        value.isWellFormed() &&
        (format === null || format.accepts(value))) ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'number' &&
        typeof value === 'number' &&
        Number.isFinite(value)) ||
      (type === 'integer' &&
        typeof value === 'number' &&
        Number.isSafeInteger(value))
    )
      return value;
    throw new TypeError(
      format === null
        ? `Key/cursor field ${field} requires non-null ${type}`
        : `Key/cursor field ${field} requires a canonical ${format.name} value`,
    );
  }

  key(record: unknown): string {
    return JSON.stringify(
      this.primaryKey.map((field) => this.value(record, field)),
    );
  }

  cursor(record: unknown): string | number {
    if (this.cursorField === undefined)
      throw new TypeError('Deduplication has no cursor field');
    const value = this.value(record, this.cursorField);
    if (typeof value === 'boolean')
      throw new TypeError('Cursor cannot be boolean');
    return value;
  }

  newer(record: unknown, previous: unknown): boolean {
    const value = this.cursor(record);
    const saved = this.cursor(previous);
    if (typeof value !== 'string' || typeof saved !== 'string')
      return value > saved;
    const format =
      this.cursorField === undefined ? null : this.format(this.cursorField);
    if (format === null)
      return Buffer.compare(Buffer.from(value), Buffer.from(saved)) > 0;
    return format.compare(value, saved) > 0;
  }
}
