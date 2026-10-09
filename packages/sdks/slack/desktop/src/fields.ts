import { SlackDesktopFormatError } from './errors.ts';

// One object of the Slack app's state, read field by field: a field of the
// wrong type fails with its path; an absent or null field reads as null.
export class Fields {
  readonly #value: Readonly<Record<string, unknown>>;
  readonly #record: string;
  readonly #path: string;

  constructor(value: unknown, record: string, path: string) {
    if (!isObject(value))
      throw new SlackDesktopFormatError(record, `${path} is not an object`);
    this.#value = value;
    this.#record = record;
    this.#path = path;
  }

  #fail(name: string, expected: string): never {
    throw new SlackDesktopFormatError(
      this.#record,
      `${this.#path}.${name} is not ${expected}`,
    );
  }

  has(name: string): boolean {
    return this.#value[name] !== undefined && this.#value[name] !== null;
  }

  // An absent field and an empty string both mean Slack holds no value.
  string(name: string): string | null {
    const value = this.#value[name];
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value : this.#fail(name, 'a string');
  }

  requiredString(name: string): string {
    return this.string(name) ?? this.#fail(name, 'a non-empty string');
  }

  requiredNumber(name: string): number {
    return this.number(name) ?? this.#fail(name, 'a number');
  }

  number(name: string): number | null {
    const value = this.#value[name];
    if (value === undefined || value === null) return null;
    return typeof value === 'number' ? value : this.#fail(name, 'a number');
  }

  boolean(name: string): boolean | null {
    const value = this.#value[name];
    if (value === undefined || value === null) return null;
    return typeof value === 'boolean' ? value : this.#fail(name, 'a boolean');
  }

  strings(name: string): string[] {
    const value = this.#value[name];
    if (value === undefined || value === null) return [];
    if (
      !Array.isArray(value) ||
      !value.every((item): item is string => typeof item === 'string')
    )
      return this.#fail(name, 'a list of strings');
    return value;
  }

  object(name: string): Fields | null {
    return this.has(name)
      ? new Fields(this.#value[name], this.#record, `${this.#path}.${name}`)
      : null;
  }

  // An object's own entries, each read as Fields: Slack's state keys most
  // collections by id.
  entries(name: string): [string, Fields][] {
    const value = this.#value[name];
    if (value === undefined || value === null) return [];
    if (!isObject(value)) return this.#fail(name, 'an object');
    return Object.entries(value).map(([key, item]) => [
      key,
      new Fields(item, this.#record, `${this.#path}.${name}.${key}`),
    ]);
  }

  // An object's own entries as Slack holds them, such as preferences by name.
  values(name: string): [string, unknown][] {
    const value = this.#value[name];
    if (value === undefined || value === null) return [];
    return isObject(value)
      ? Object.entries(value)
      : this.#fail(name, 'an object');
  }

  // An object whose every value is a string, such as each channel's last read
  // ts by channel id.
  stringValues(name: string): Map<string, string> {
    return new Map(
      this.values(name).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value
          : this.#fail(`${name}.${key}`, 'a string'),
      ]),
    );
  }

  list(name: string): Fields[] {
    const value = this.#value[name];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return this.#fail(name, 'a list');
    return value.map(
      (item, index) =>
        new Fields(item, this.#record, `${this.#path}.${name}[${index}]`),
    );
  }

  // A value kept as the JSON Slack holds, for structures this reader passes
  // through whole, such as a message's rich-text blocks.
  json(name: string): string | null {
    return this.has(name) ? JSON.stringify(this.#value[name]) : null;
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
