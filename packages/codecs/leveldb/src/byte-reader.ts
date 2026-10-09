import { LevelDBFormatError } from './errors.ts';

// LevelDB's integers read from one file's bytes: fixed-width little-endian
// and base-128 varints. Reading past the end is a format error, never a
// short value.
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly path: string;
  offset: number;

  constructor(bytes: Uint8Array, path: string, offset = 0) {
    this.bytes = bytes;
    this.path = path;
    this.offset = offset;
  }

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  take(length: number): Uint8Array {
    const end = this.offset + length;
    if (end > this.bytes.length)
      throw new LevelDBFormatError(
        this.path,
        `${length} bytes at offset ${this.offset} run past the end`,
      );
    const slice = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }

  byte(): number {
    return this.take(1)[0] ?? 0;
  }

  fixed32(): number {
    const bytes = this.take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  fixed64(): bigint {
    const bytes = this.take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(
      0,
      true,
    );
  }

  // File numbers, sizes and sequence numbers stay far below 2^53.
  varint(): number {
    const start = this.offset;
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.byte();
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value))
          throw new LevelDBFormatError(
            this.path,
            `the varint at offset ${start} exceeds 2^53`,
          );
        return value;
      }
    }
    throw new LevelDBFormatError(
      this.path,
      `the varint at offset ${start} runs longer than 64 bits`,
    );
  }

  lengthPrefixed(): Uint8Array {
    return this.take(this.varint());
  }
}
