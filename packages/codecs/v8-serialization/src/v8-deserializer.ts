// V8's ValueSerializer format, formats 13 to 16, as structured clone, Node's
// v8.serialize and Chromium's IndexedDB write it: a header (0xFF, version)
// and one tagged value. Format 16 widened buffer and view sizes to 64-bit
// varints; nothing else changed since 13, so one reader covers all four.
// https://github.com/v8/v8/blob/fedd021b538607860f9c56e5c193ad8dcd4f2bb1/src/objects/value-serializer.cc
const oldestVersion = 13;
const newestVersion = 16;

export class V8FormatError extends Error {
  override name = 'V8FormatError';

  constructor(offset: number, problem: string) {
    super(`V8 serialized data at offset ${offset}: ${problem}`);
  }
}

const regExpFlags = [
  ['g', 1],
  ['i', 2],
  ['m', 4],
  ['y', 8],
  ['u', 16],
  ['s', 32],
  ['d', 128],
  ['v', 256],
] as const;

const viewTypes = {
  b: Int8Array,
  B: Uint8Array,
  C: Uint8ClampedArray,
  w: Int16Array,
  W: Uint16Array,
  d: Int32Array,
  D: Uint32Array,
  f: Float32Array,
  F: Float64Array,
  q: BigInt64Array,
  Q: BigUint64Array,
} as const;

const errorPrototypes = {
  E: EvalError,
  R: RangeError,
  F: ReferenceError,
  S: SyntaxError,
  T: TypeError,
  U: URIError,
} as const;

export function deserializeV8(bytes: Uint8Array): unknown {
  return new V8Reader(bytes).read();
}

class V8Reader {
  readonly #bytes: Uint8Array;
  #offset = 0;
  #version = 0;
  // Every object takes the next id as V8 reads it, so a later reference
  // (^ and an id) finds the same object.
  readonly #objects: unknown[] = [];

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  read(): unknown {
    if (this.#byte() !== 0xff)
      throw new V8FormatError(0, 'it has no version header');
    this.#version = this.#varint();
    if (this.#version < oldestVersion || this.#version > newestVersion)
      throw new V8FormatError(
        1,
        `format version ${this.#version} is outside ${oldestVersion} to ${newestVersion}`,
      );
    return this.#value();
  }

  #fail(problem: string, offset = this.#offset): never {
    throw new V8FormatError(offset, problem);
  }

  #take(length: number): Uint8Array {
    const end = this.#offset + length;
    if (end > this.#bytes.length)
      this.#fail(`${length} bytes run past the end`);
    const slice = this.#bytes.subarray(this.#offset, end);
    this.#offset = end;
    return slice;
  }

  #byte(): number {
    return this.#take(1)[0] ?? 0;
  }

  #varint(): number {
    const start = this.#offset;
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.#byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value))
          this.#fail('a varint exceeds 2^53', start);
        return value;
      }
    }
    return this.#fail('a varint runs longer than 64 bits', start);
  }

  #double(): number {
    const bytes = this.#take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }

  // Padding bytes (0) align two-byte strings; they stand where a tag would.
  #tag(): string {
    let byte = this.#byte();
    while (byte === 0) byte = this.#byte();
    return String.fromCharCode(byte);
  }

  #peekTag(): string {
    let offset = this.#offset;
    while (this.#bytes[offset] === 0) offset++;
    const byte = this.#bytes[offset];
    return byte === undefined ? '' : String.fromCharCode(byte);
  }

  #remember<T>(object: T): T {
    this.#objects.push(object);
    return object;
  }

  #value(): unknown {
    const start = this.#offset;
    const tag = this.#tag();
    switch (tag) {
      case '_':
        return undefined;
      case '0':
        return null;
      case 'T':
        return true;
      case 'F':
        return false;
      case 'I': {
        const zigzag = this.#varint();
        return (zigzag >>> 1) ^ -(zigzag & 1);
      }
      case 'U':
        return this.#varint();
      case 'N':
        return this.#double();
      case 'Z':
        return this.#bigint();
      case '"':
        return Buffer.from(this.#take(this.#varint())).toString('latin1');
      case 'c':
        return this.#twoByteString();
      case 'S':
        return Buffer.from(this.#take(this.#varint())).toString('utf8');
      case '?':
        this.#varint();
        return this.#value();
      case '^': {
        const id = this.#varint();
        if (id >= this.#objects.length)
          this.#fail(`it refers to object ${id} before reading it`, start);
        return this.#view(this.#objects[id]);
      }
      case 'o':
        return this.#object();
      case 'A':
        return this.#denseArray();
      case 'a':
        return this.#sparseArray();
      case 'D':
        return this.#remember(new Date(this.#double()));
      case 'y':
        return this.#remember(true);
      case 'x':
        return this.#remember(false);
      case 'n':
        return this.#remember(this.#double());
      case 'z':
        return this.#remember(this.#bigint());
      case 's': {
        const id = this.#objects.length;
        this.#objects.push(undefined);
        const value = this.#value();
        this.#objects[id] = value;
        return value;
      }
      case 'R':
        return this.#regExp();
      case ';':
        return this.#map();
      case "'":
        return this.#set();
      case 'B':
      case 'C':
        return this.#view(this.#remember(this.#buffer(this.#varint())));
      case '~': {
        const length = this.#varint();
        const maxLength = this.#varint();
        return this.#view(this.#remember(this.#buffer(length, maxLength)));
      }
      case 'r':
        return this.#error();
      default:
        return this.#fail(
          `tag '${tag}' (0x${tag.charCodeAt(0).toString(16)}) is not a value a store holds`,
          start,
        );
    }
  }

  #bigint(): bigint {
    const bitfield = this.#varint();
    const digits = this.#take(Math.floor(bitfield / 2));
    let value = 0n;
    for (let index = digits.length - 1; index >= 0; index--)
      value = (value << 8n) | BigInt(digits[index] ?? 0);
    return bitfield & 1 ? -value : value;
  }

  #twoByteString(): string {
    const length = this.#varint();
    if (length % 2 !== 0) this.#fail(`a two-byte string of ${length} bytes`);
    return Buffer.from(this.#take(length)).toString('utf16le');
  }

  #key(): string {
    const key = this.#value();
    if (typeof key === 'string') return key;
    if (typeof key === 'number') return String(key);
    return this.#fail(`a property key of type ${typeof key}`);
  }

  #properties(
    target: Record<string, unknown> | unknown[],
    end: string,
  ): number {
    let count = 0;
    while (this.#peekTag() !== end) {
      Reflect.set(target, this.#key(), this.#value());
      count++;
    }
    this.#tag();
    return count;
  }

  #checkCount(expected: number, actual: number, what: string): void {
    if (expected !== actual)
      this.#fail(`${what} declares ${expected} entries and holds ${actual}`);
  }

  #object(): Record<string, unknown> {
    const object = this.#remember<Record<string, unknown>>({});
    const count = this.#properties(object, '{');
    this.#checkCount(this.#varint(), count, 'an object');
    return object;
  }

  #denseArray(): unknown[] {
    const length = this.#varint();
    const array = this.#remember<unknown[]>(new Array(length));
    for (let index = 0; index < length; index++) {
      if (this.#peekTag() === '-') {
        this.#tag();
        continue;
      }
      array[index] = this.#value();
    }
    const count = this.#properties(array, '$');
    this.#checkCount(this.#varint(), count, 'an array');
    this.#checkCount(this.#varint(), length, 'an array length');
    return array;
  }

  #sparseArray(): unknown[] {
    const length = this.#varint();
    const array = this.#remember<unknown[]>(new Array(length));
    const count = this.#properties(array, '@');
    this.#checkCount(this.#varint(), count, 'a sparse array');
    this.#checkCount(this.#varint(), length, 'a sparse array length');
    return array;
  }

  #regExp(): RegExp {
    const id = this.#objects.length;
    this.#objects.push(undefined);
    const pattern = this.#value();
    if (typeof pattern !== 'string') this.#fail('a RegExp without a pattern');
    const bits = this.#varint();
    const flags = regExpFlags
      .filter(([, bit]) => bits & bit)
      .map(([flag]) => flag)
      .join('');
    const regExp = new RegExp(pattern, flags);
    this.#objects[id] = regExp;
    return regExp;
  }

  #map(): Map<unknown, unknown> {
    const map = this.#remember(new Map<unknown, unknown>());
    while (this.#peekTag() !== ':') map.set(this.#value(), this.#value());
    this.#tag();
    this.#checkCount(this.#varint(), map.size * 2, 'a Map');
    return map;
  }

  #set(): Set<unknown> {
    const set = this.#remember(new Set<unknown>());
    while (this.#peekTag() !== ',') set.add(this.#value());
    this.#tag();
    this.#checkCount(this.#varint(), set.size, 'a Set');
    return set;
  }

  #buffer(length: number, maxByteLength?: number): ArrayBuffer {
    const buffer =
      maxByteLength === undefined
        ? new ArrayBuffer(length)
        : new ArrayBuffer(length, { maxByteLength });
    new Uint8Array(buffer).set(this.#take(length));
    return buffer;
  }

  // A view over a buffer follows the buffer itself, or a reference to it.
  #view(value: unknown): unknown {
    if (!(value instanceof ArrayBuffer) || this.#peekTag() !== 'V')
      return value;
    this.#tag();
    const start = this.#offset;
    const type = String.fromCharCode(this.#varint());
    const byteOffset = this.#varint();
    const byteLength = this.#varint();
    if (this.#version >= 14) this.#varint();
    if (type === '?')
      return this.#remember(new DataView(value, byteOffset, byteLength));
    const View = Object.entries(viewTypes).find(([name]) => name === type)?.[1];
    if (View === undefined) this.#fail(`view type '${type}'`, start);
    return this.#remember(
      new View(value, byteOffset, byteLength / View.BYTES_PER_ELEMENT),
    );
  }

  #error(): Error {
    const id = this.#objects.length;
    this.#objects.push(undefined);
    let Prototype: ErrorConstructor = Error;
    let message: string | undefined;
    let stack: unknown;
    let cause: unknown;
    let hasCause = false;
    for (;;) {
      const tag = this.#tag();
      if (tag === '.') break;
      const prototype = Object.entries(errorPrototypes).find(
        ([name]) => name === tag,
      )?.[1];
      if (prototype !== undefined) Prototype = prototype;
      else if (tag === 'm') message = this.#string();
      else if (tag === 's') stack = this.#string();
      else if (tag === 'c') {
        cause = this.#value();
        hasCause = true;
      } else this.#fail(`error field '${tag}'`);
    }
    const error = new Prototype(message, hasCause ? { cause } : undefined);
    if (stack !== undefined) error.stack = String(stack);
    this.#objects[id] = error;
    return error;
  }

  #string(): string {
    const value = this.#value();
    if (typeof value !== 'string') this.#fail('a string field holds no string');
    return value;
  }
}
