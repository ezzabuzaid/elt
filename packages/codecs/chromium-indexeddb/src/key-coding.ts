import { ByteReader } from './byte-reader.ts';

// A key IndexedDB stores records under.
export type IndexedDBKey =
  string | number | Date | Uint8Array | readonly IndexedDBKey[];

// Every LevelDB key starts with which database, object store and index it
// belongs to: one byte packing each id's length, then the three ids.
// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/indexed_db/indexed_db_leveldb_coding.cc#L1749-L1835
export type KeyPrefix = {
  readonly database: number;
  readonly objectStore: number;
  readonly index: number;
};

export function readPrefix(reader: ByteReader): KeyPrefix {
  const lengths = reader.byte();
  return {
    database: reader.int((lengths >> 5) + 1),
    objectStore: reader.int(((lengths >> 2) & 7) + 1),
    index: reader.int((lengths & 3) + 1),
  };
}

const stringKey = 1;
const dateKey = 2;
const numberKey = 3;
const arrayKey = 4;
const binaryKey = 6;

// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/indexed_db/indexed_db_leveldb_coding.cc#L788-L851
export function readKey(reader: ByteReader): IndexedDBKey {
  const type = reader.byte();
  if (type === stringKey) return reader.stringWithLength();
  if (type === dateKey) return new Date(reader.double());
  if (type === numberKey) return reader.double();
  if (type === binaryKey) return reader.take(reader.varint()).slice();
  if (type === arrayKey)
    return Array.from({ length: reader.varint() }, () => readKey(reader));
  return reader.fail(`key type ${type}`);
}
