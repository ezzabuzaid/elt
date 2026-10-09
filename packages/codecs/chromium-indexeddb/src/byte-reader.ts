import { IndexedDBFormatError } from './errors.ts';

// Chromium IndexedDB's primitives over one key or value. Reading past the end
// is a format error, never a short value.
// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/indexed_db/indexed_db_leveldb_coding.cc#L461-L502
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly path: string;
  offset = 0;

  constructor(bytes: Uint8Array, path: string) {
    this.bytes = bytes;
    this.path = path;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  fail(problem: string): never {
    throw new IndexedDBFormatError(this.path, problem);
  }

  take(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length)
      this.fail(`${length} bytes at offset ${this.offset} run past the end`);
    const slice = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }

  byte(): number {
    return this.take(1)[0] ?? 0;
  }

  rest(): Uint8Array {
    return this.take(this.bytes.length - this.offset);
  }

  // Unsigned LEB128; Blink's own varints in a wrapped value read the same.
  varint(): number {
    const start = this.offset;
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value))
          this.fail(`the varint at offset ${start} exceeds 2^53`);
        return value;
      }
    }
    return this.fail(`the varint at offset ${start} runs longer than 64 bits`);
  }

  // A little-endian integer in as few bytes as it needs.
  int(length: number): number {
    let value = 0;
    for (const [index, byte] of this.take(length).entries())
      value += byte * 2 ** (8 * index);
    return value;
  }

  double(): number {
    const bytes = this.take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }

  // UTF-16BE code units: the rest of the slice, or a counted run of them.
  string(units = (this.bytes.length - this.offset) / 2): string {
    return Buffer.from(this.take(units * 2))
      .swap16()
      .toString('utf16le');
  }

  stringWithLength(): string {
    return this.string(this.varint());
  }
}
