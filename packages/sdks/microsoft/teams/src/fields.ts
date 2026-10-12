import { TeamsFormatError } from './errors.ts';

// One object of the Teams client's caches, read field by field: a field of
// the wrong type fails with its path; an absent or null field reads as null.
export class Fields {
  readonly #value: Readonly<Record<string, unknown>>;
  readonly #record: string;
  readonly #path: string;

  constructor(value: unknown, record: string, path: string) {
    if (!isObject(value))
      throw new TeamsFormatError(record, `${path} is not an object`);
    this.#value = value;
    this.#record = record;
    this.#path = path;
  }

  #fail(name: string, expected: string): never {
    throw new TeamsFormatError(
      this.#record,
      `${this.#path}.${name} is not ${expected}`,
    );
  }

  has(name: string): boolean {
    return this.#value[name] !== undefined && this.#value[name] !== null;
  }

  // An absent field and an empty string both mean Teams holds no value.
  string(name: string): string | null {
    const value = this.#value[name];
    if (value === undefined || value === null || value === '') return null;
    return typeof value === 'string' ? value : this.#fail(name, 'a string');
  }

  requiredString(name: string): string {
    return this.string(name) ?? this.#fail(name, 'a non-empty string');
  }

  // An id Teams writes as a number in some records and as text in others.
  text(name: string): string | null {
    const value = this.#value[name];
    if (typeof value === 'number') return String(value);
    return this.string(name);
  }

  requiredText(name: string): string {
    return this.text(name) ?? this.#fail(name, 'a non-empty id');
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

  // A flag Teams keeps as a boolean in some records and as "true" or "false"
  // (any case) in others.
  flag(name: string): boolean | null {
    const value = this.#value[name];
    if (typeof value !== 'string') return this.boolean(name);
    const lower = value.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return value === '' ? null : this.#fail(name, 'true or false');
  }

  // A count of milliseconds since 1970 as an instant, written as a number or
  // as its digits; 0 means none.
  milliseconds(name: string): string | null {
    const value = this.#value[name];
    if (value === undefined || value === null || value === '') return null;
    const count =
      typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (count === 0) return null;
    const date = new Date(typeof count === 'number' ? count : Number.NaN);
    return Number.isNaN(date.getTime())
      ? this.#fail(name, 'a count of milliseconds')
      : date.toISOString();
  }

  requiredMilliseconds(name: string): string {
    return (
      this.milliseconds(name) ?? this.#fail(name, 'a count of milliseconds')
    );
  }

  // An instant Teams writes as ISO 8601 text, in UTC or at an offset, with
  // up to precision fraction digits: the services that write them trim
  // trailing zeros, and some count ten-millionths of a second, which a Date
  // would round. Offsets are whole minutes, so the fraction carries over.
  instant(name: string, precision: number): string | null {
    const value = this.string(name);
    if (value === null) return null;
    const parts =
      /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(
        value,
      );
    const fraction = parts?.[2] ?? '';
    const seconds = parts ? Date.parse(`${parts[1]}${parts[3]}`) : Number.NaN;
    if (Number.isNaN(seconds) || fraction.length > precision)
      return this.#fail(name, `an instant to ${precision} fraction digits`);
    const whole = new Date(seconds).toISOString().slice(0, 19);
    return `${whole}.${fraction.padEnd(precision, '0')}Z`;
  }

  requiredInstant(name: string, precision: number): string {
    return (
      this.instant(name, precision) ??
      this.#fail(name, `an instant to ${precision} fraction digits`)
    );
  }

  requiredDate(name: string): string {
    const value = this.#value[name];
    return value instanceof Date && !Number.isNaN(value.getTime())
      ? value.toISOString()
      : this.#fail(name, 'a date');
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

  // An object's own entries, each read as Fields: Teams keys a reply chain's
  // messages by sender and client id.
  entries(name: string): [string, Fields][] {
    const value = this.#value[name];
    if (value === undefined || value === null) return [];
    if (!isObject(value)) return this.#fail(name, 'an object');
    return Object.entries(value).map(([key, item]) => [
      key,
      new Fields(item, this.#record, `${this.#path}.${name}.${key}`),
    ]);
  }

  list(name: string): Fields[] {
    const value = this.#value[name];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return this.#fail(name, 'a list');
    return this.#items(name, value);
  }

  // An object Teams keeps either as itself or as its JSON text.
  parsedObject(name: string): Fields | null {
    const value = this.#parsed(name);
    return value === null
      ? null
      : new Fields(value, this.#record, `${this.#path}.${name}`);
  }

  // A list Teams keeps either as itself or as its JSON text.
  parsedList(name: string): Fields[] {
    const value = this.#parsed(name);
    if (value === null) return [];
    if (!Array.isArray(value)) return this.#fail(name, 'a list');
    return this.#items(name, value);
  }

  // A value kept as the JSON Teams holds, for structures this reader passes
  // through whole, such as a message's adaptive cards.
  json(name: string): string | null {
    const value = this.#parsed(name);
    return value === null ||
      (Array.isArray(value) && value.length === 0) ||
      (isObject(value) && Object.keys(value).length === 0)
      ? null
      : JSON.stringify(value);
  }

  #parsed(name: string): unknown {
    const value = this.#value[name];
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (error) {
      // Teams writes its JSON without whitespace, yet keeps some link
      // previews' line breaks raw inside their text, where JSON escapes them.
      const escaped = [...value]
        .map((character) =>
          character < ' '
            ? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
            : character,
        )
        .join('');
      try {
        return JSON.parse(escaped);
      } catch {
        throw new TeamsFormatError(
          this.#record,
          `${this.#path}.${name} is not JSON`,
          error,
        );
      }
    }
  }

  #items(name: string, items: readonly unknown[]): Fields[] {
    return items.map(
      (item, index) =>
        new Fields(item, this.#record, `${this.#path}.${name}[${index}]`),
    );
  }
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
