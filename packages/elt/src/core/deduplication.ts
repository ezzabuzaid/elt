import type { Stream } from './stream.ts';

// The selected logical identity and ordering rule, independent of storage constraints.
export class Deduplication {
  readonly primaryKey: readonly string[];

  constructor(
    readonly stream: Stream,
    primaryKey: readonly string[],
    // Absent when the newest extraction always wins (dedupPolicy replace).
    readonly cursorField?: string,
  ) {
    if (
      !Array.isArray(primaryKey) ||
      primaryKey.length === 0 ||
      new Set(primaryKey).size !== primaryKey.length
    )
      throw new TypeError('Deduplication requires distinct primaryKey fields');
    this.primaryKey = Object.freeze([...primaryKey]);
    for (const field of this.primaryKey) this.type(field);
    if (
      cursorField !== undefined &&
      !['string', 'number', 'integer'].includes(this.type(cursorField))
    )
      throw new TypeError('Deduplication cursor must be text or numeric');
    Object.freeze(this);
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
    if (
      (type === 'string' &&
        typeof value === 'string' &&
        value.isWellFormed()) ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'number' &&
        typeof value === 'number' &&
        Number.isFinite(value)) ||
      (type === 'integer' &&
        typeof value === 'number' &&
        Number.isSafeInteger(value))
    )
      return value;
    throw new TypeError(`Key/cursor field ${field} requires non-null ${type}`);
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
    if (typeof value === 'string' && typeof saved === 'string')
      return Buffer.compare(Buffer.from(value), Buffer.from(saved)) > 0;
    return value > saved;
  }
}
