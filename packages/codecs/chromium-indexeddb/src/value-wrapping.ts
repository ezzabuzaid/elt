import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import snappy from 'snappyjs';

import { deserializeV8 } from '@workspace/codec-v8-serialization';

import { ByteReader } from './byte-reader.ts';

// What Blink stores for one record, after LevelDB's record version: the
// value serialized by V8 inside Blink's envelope, Snappy-compressed when large
// (FF 11 02), and moved to a blob file when still large (FF 11 01, its size
// and its index among the record's external objects).
// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/third_party/blink/renderer/modules/indexeddb/idb_value_wrapping.cc
const wrapperVersion = 0x11;
const replacedWithBlob = 0x01;
const compressedWithSnappy = 0x02;
// Blink versions from 16 put an envelope before V8's own header; from 21 it
// holds the offset and size of a trailer after the V8 value.
const firstEnvelope = 16;
const firstTrailer = 21;
const trailerOffsetTag = 0xfe;

// A blob a record keeps outside LevelDB, as its blob entry lists it.
type ExternalObject = { readonly blobNumber: number } | null;

export async function unwrapValue(
  bytes: Uint8Array,
  externalObjects: readonly ExternalObject[],
  blobDirectory: string,
  database: number,
  path: string,
): Promise<unknown> {
  const reader = new ByteReader(bytes, path);
  if (bytes[0] === 0xff && bytes[1] === wrapperVersion) {
    if (bytes[2] === replacedWithBlob) {
      reader.offset = 3;
      const size = reader.varint();
      const index = reader.varint();
      const object = externalObjects[index];
      if (object === undefined || object === null)
        return reader.fail(
          `the value names blob ${index}, which it does not list`,
        );
      const blob = await readFile(
        blobPath(blobDirectory, database, object.blobNumber),
      );
      if (blob.length !== size)
        return reader.fail(
          `blob ${object.blobNumber} holds ${blob.length} bytes, not ${size}`,
        );
      return unwrapValue(blob, [], blobDirectory, database, path);
    }
    if (bytes[2] === compressedWithSnappy)
      return deserialize(snappy.uncompress(bytes.subarray(3)), path);
  }
  return deserialize(bytes, path);
}

// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/indexed_db/file_path_util.cc#L81-L102
function blobPath(directory: string, database: number, number: number): string {
  return join(
    directory,
    database.toString(16),
    ((number & 0xff00) >> 8).toString(16).padStart(2, '0'),
    number.toString(16),
  );
}

// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/third_party/blink/renderer/bindings/core/v8/serialization/v8_script_value_deserializer.cc#L97-L146
function deserialize(bytes: Uint8Array, path: string): unknown {
  const reader = new ByteReader(bytes, path);
  if (reader.byte() !== 0xff) return reader.fail('the value has no version');
  const version = reader.varint();
  if (version < firstEnvelope) return deserializeV8(bytes);
  let end = bytes.length;
  if (version >= firstTrailer) {
    if (reader.byte() !== trailerOffsetTag)
      return reader.fail('the envelope has no trailer offset');
    const trailer = reader.take(12);
    const view = new DataView(trailer.buffer, trailer.byteOffset, 12);
    const offset = Number(view.getBigUint64(0));
    if (offset !== 0) end = offset;
  }
  return deserializeV8(bytes.subarray(reader.offset, end));
}

// The external objects a blob entry lists, in order: blobs (0) and files (1)
// by blob number, and File System Access handles (2), which have none.
// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/indexed_db/instance/leveldb/backing_store.cc#L535-L597
export function readExternalObjects(
  bytes: Uint8Array,
  path: string,
): ExternalObject[] {
  const reader = new ByteReader(bytes, path);
  const objects: ExternalObject[] = [];
  while (!reader.done) {
    const type = reader.byte();
    if (type === 2) {
      reader.take(reader.varint());
      objects.push(null);
      continue;
    }
    if (type !== 0 && type !== 1)
      return reader.fail(`external object type ${type}`);
    const blobNumber = reader.varint();
    reader.stringWithLength();
    reader.varint();
    if (type === 1) {
      reader.stringWithLength();
      reader.varint();
    }
    objects.push({ blobNumber });
  }
  return objects;
}
