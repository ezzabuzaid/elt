import { ByteReader } from './byte-reader.ts';
import { maskedCrc32c } from './crc32c.ts';
import { LevelDBFormatError } from './errors.ts';

// One write to a LevelDB key: its value, or null for a deletion.
export type LevelDBEntry = {
  readonly key: Uint8Array;
  readonly sequence: number;
  readonly value: Uint8Array | null;
};

// The log (and the MANIFEST) in 32 KiB blocks of records, each a 7-byte
// header (masked CRC-32C of type and payload, payload length, type) and a
// payload: a whole logical record, or its first, middle or last fragment.
// https://github.com/google/leveldb/blob/7ee830d02b623e8ffe0b95d59a74db1e58da04c5/doc/log_format.md
const blockSize = 32768;
const headerSize = 7;
const full = 1;
const first = 2;
const middle = 3;
const last = 4;

export function* logRecords(
  bytes: Uint8Array,
  path: string,
): Generator<Uint8Array> {
  let fragments: Uint8Array[] | null = null;
  for (let block = 0; block < bytes.length; block += blockSize) {
    const end = Math.min(block + blockSize, bytes.length);
    const reader = new ByteReader(bytes.subarray(0, end), path, block);
    while (end - reader.offset >= headerSize) {
      const checksum = reader.fixed32();
      const length = reader.byte() | (reader.byte() << 8);
      const type = reader.byte();
      // Space the writer preallocated and has not reached yet.
      if (type === 0 && length === 0) break;
      // A record the writer is still appending ends the log, as it does
      // when LevelDB itself recovers.
      if (reader.offset + length > bytes.length) return;
      const payload = reader.take(length);
      if (maskedCrc32c(Uint8Array.of(type), payload) !== checksum)
        throw new LevelDBFormatError(
          path,
          `the record at offset ${reader.offset - length - headerSize} fails its checksum`,
        );
      if (type === full) yield payload;
      else if (type === first) fragments = [payload];
      else if ((type === middle || type === last) && fragments !== null) {
        fragments.push(payload);
        if (type === last) {
          yield Buffer.concat(fragments);
          fragments = null;
        }
      } else
        throw new LevelDBFormatError(
          path,
          `record type ${type} at offset ${reader.offset - length - headerSize} is out of order`,
        );
    }
  }
}

// A logical log record is a write batch: a sequence number, a count, and that
// many puts (1) and deletions (0), numbered from the batch's sequence on.
// https://github.com/google/leveldb/blob/7ee830d02b623e8ffe0b95d59a74db1e58da04c5/db/write_batch.cc#L5-L14
export function* logEntries(
  bytes: Uint8Array,
  path: string,
): Generator<LevelDBEntry> {
  for (const record of logRecords(bytes, path)) {
    const reader = new ByteReader(record, path);
    const sequence = Number(reader.fixed64());
    const count = reader.fixed32();
    for (let index = 0; index < count; index++) {
      const type = reader.byte();
      const key = reader.lengthPrefixed();
      if (type === 1)
        yield {
          key,
          sequence: sequence + index,
          value: reader.lengthPrefixed(),
        };
      else if (type === 0)
        yield { key, sequence: sequence + index, value: null };
      else throw new LevelDBFormatError(path, `write batch entry type ${type}`);
    }
  }
}
