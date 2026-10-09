import snappy from 'snappyjs';

import { ByteReader } from './byte-reader.ts';
import { maskedCrc32c } from './crc32c.ts';
import { LevelDBFormatError } from './errors.ts';
import type { LevelDBEntry } from './log.ts';

// A table file (.ldb, formerly .sst): data blocks, an index block of their
// handles, and a 48-byte footer ending in a magic number. Each block is
// followed by its compression type and a masked CRC-32C.
// https://github.com/google/leveldb/blob/7ee830d02b623e8ffe0b95d59a74db1e58da04c5/doc/table_format.md
const footerSize = 48;
const magic = 0xdb4775248b80fb57n;
const uncompressed = 0;
const snappyCompressed = 1;

export function* tableEntries(
  bytes: Uint8Array,
  path: string,
): Generator<LevelDBEntry> {
  if (bytes.length < footerSize)
    throw new LevelDBFormatError(path, 'the table is shorter than its footer');
  const footer = new ByteReader(bytes, path, bytes.length - footerSize);
  footer.varint();
  footer.varint();
  const index = { offset: footer.varint(), size: footer.varint() };
  footer.offset = bytes.length - 8;
  if (footer.fixed64() !== magic)
    throw new LevelDBFormatError(path, 'the footer has no table magic number');
  for (const { value } of blockEntries(block(bytes, path, index), path)) {
    const handle = new ByteReader(value, path);
    const data = { offset: handle.varint(), size: handle.varint() };
    for (const entry of blockEntries(block(bytes, path, data), path))
      yield internalEntry(entry.key, entry.value, path);
  }
}

function block(
  bytes: Uint8Array,
  path: string,
  { offset, size }: { readonly offset: number; readonly size: number },
): Uint8Array {
  const reader = new ByteReader(bytes, path, offset);
  const contents = reader.take(size);
  const type = reader.byte();
  if (maskedCrc32c(contents, Uint8Array.of(type)) !== reader.fixed32())
    throw new LevelDBFormatError(
      path,
      `the block at offset ${offset} fails its checksum`,
    );
  if (type === uncompressed) return contents;
  if (type === snappyCompressed) return snappy.uncompress(contents);
  throw new LevelDBFormatError(
    path,
    `the block at offset ${offset} uses compression type ${type}`,
  );
}

// Entries share a prefix with the one before them; restart points, listed at
// the block's end, reset the prefix to nothing.
function* blockEntries(
  contents: Uint8Array,
  path: string,
): Generator<{ readonly key: Uint8Array; readonly value: Uint8Array }> {
  const tail = new ByteReader(contents, path, contents.length - 4);
  const restarts = tail.fixed32();
  const end = contents.length - 4 - restarts * 4;
  if (end < 0)
    throw new LevelDBFormatError(path, `a block lists ${restarts} restarts`);
  const reader = new ByteReader(contents.subarray(0, end), path);
  let previous = new Uint8Array();
  while (!reader.done) {
    const shared = reader.varint();
    const unshared = reader.varint();
    const length = reader.varint();
    if (shared > previous.length)
      throw new LevelDBFormatError(
        path,
        `an entry shares ${shared} bytes of a ${previous.length}-byte key`,
      );
    const key = Buffer.concat([
      previous.subarray(0, shared),
      reader.take(unshared),
    ]);
    yield { key, value: reader.take(length) };
    previous = key;
  }
}

// A table key is the user key followed by 8 bytes holding the sequence number
// shifted left 8 and the entry type: 1 a value, 0 a deletion.
function internalEntry(
  key: Uint8Array,
  value: Uint8Array,
  path: string,
): LevelDBEntry {
  if (key.length < 8)
    throw new LevelDBFormatError(path, 'a table key has no sequence number');
  const trailer = new ByteReader(key, path, key.length - 8).fixed64();
  const type = Number(trailer & 0xffn);
  const sequence = Number(trailer >> 8n);
  const user = key.subarray(0, key.length - 8);
  if (type === 1) return { key: user, sequence, value };
  if (type === 0) return { key: user, sequence, value: null };
  throw new LevelDBFormatError(path, `table entry type ${type}`);
}
