import { LevelDBFormatError, readLevelDB } from '@workspace/codec-leveldb';
import { V8FormatError } from '@workspace/codec-v8-serialization';

import { ByteReader } from './byte-reader.ts';
import { IndexedDBFormatError } from './errors.ts';
import { type IndexedDBKey, readKey, readPrefix } from './key-coding.ts';
import { readExternalObjects, unwrapValue } from './value-wrapping.ts';

export type IndexedDBRecord = {
  readonly key: IndexedDBKey;
  readonly value: unknown;
};

export type IndexedDBObjectStore = {
  readonly name: string;
  readonly records: readonly IndexedDBRecord[];
};

export type IndexedDBDatabase = {
  // The origin's identifier, such as https_app.slack.com_0@1.
  readonly origin: string;
  readonly name: string;
  readonly objectStores: readonly IndexedDBObjectStore[];
};

// Global metadata (database 0) names each database; database metadata
// (object store 0) names each object store; index 1 holds records and index 3
// the blobs they keep outside LevelDB, under the same encoded key.
// https://github.com/chromium/chromium/blob/2c592105bbcd9490a9894df48d0fe59b2c512651/content/browser/indexed_db/indexed_db_leveldb_coding.cc#L76-L91
const databaseName = 201;
const objectStoreMetadata = 50;
const objectStoreName = 0;
const recordsIndex = 1;
const blobsIndex = 3;

// Every database, object store and record in one origin's IndexedDB, read
// from its `<origin>.indexeddb.leveldb` directory and the blob directory
// beside it, without opening either. Values come back as V8 deserialized them.
// Bytes in no format this reads fail as IndexedDBFormatError, whatever layer
// they broke; files it cannot open fail with the file system's error.
export async function readIndexedDB(
  directory: string,
): Promise<IndexedDBDatabase[]> {
  try {
    return await read(directory);
  } catch (error) {
    if (error instanceof LevelDBFormatError || error instanceof V8FormatError)
      throw new IndexedDBFormatError(directory, error.message, error);
    throw error;
  }
}

async function read(directory: string): Promise<IndexedDBDatabase[]> {
  const blobDirectory = directory.replace(/\.leveldb\/?$/, '.blob');
  const databases = new Map<number, { origin: string; name: string }>();
  const storeNames = new Map<string, string>();
  const stored: {
    database: number;
    store: string;
    key: Uint8Array;
    value: Uint8Array;
  }[] = [];
  const blobEntries = new Map<string, Uint8Array>();
  for (const entry of await readLevelDB(directory)) {
    const reader = new ByteReader(entry.key, directory);
    const { database, objectStore, index } = readPrefix(reader);
    if (database === 0) {
      if (reader.byte() !== databaseName) continue;
      const origin = reader.stringWithLength();
      const name = reader.stringWithLength();
      const id = new ByteReader(entry.value, directory).int(entry.value.length);
      databases.set(id, { origin, name });
    } else if (objectStore === 0) {
      if (reader.byte() !== objectStoreMetadata) continue;
      const store = storeId(database, reader.varint());
      if (reader.byte() !== objectStoreName) continue;
      storeNames.set(store, new ByteReader(entry.value, directory).string());
    } else if (index === recordsIndex)
      stored.push({
        database,
        store: storeId(database, objectStore),
        key: reader.rest(),
        value: entry.value,
      });
    else if (index === blobsIndex)
      blobEntries.set(
        recordId(storeId(database, objectStore), reader.rest()),
        entry.value,
      );
  }
  const records = new Map<string, IndexedDBRecord[]>();
  for (const { database, store, key, value } of stored) {
    const reader = new ByteReader(value, directory);
    reader.varint();
    const blobs = blobEntries.get(recordId(store, key));
    const record = {
      key: readKey(new ByteReader(key, directory)),
      value: await unwrapValue(
        reader.rest(),
        blobs === undefined ? [] : readExternalObjects(blobs, directory),
        blobDirectory,
        database,
        directory,
      ),
    };
    const list = records.get(store);
    if (list === undefined) records.set(store, [record]);
    else list.push(record);
  }
  return [...databases].map(([database, { origin, name }]) => ({
    origin,
    name,
    objectStores: [...storeNames]
      .filter(([store]) => store.startsWith(`${database}:`))
      .map(([store, storeName]) => ({
        name: storeName,
        records: records.get(store) ?? [],
      })),
  }));
}

function storeId(database: number, objectStore: number): string {
  return `${database}:${objectStore}`;
}

function recordId(store: string, key: Uint8Array): string {
  return `${store}:${Buffer.from(key).toString('hex')}`;
}
