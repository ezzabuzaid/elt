import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import v8 from 'node:v8';

import snappy from 'snappyjs';

import { maskedCrc32c } from '@workspace/codec-leveldb';

// Writes an IndexedDB as Chromium lays it out, for tests of what reads one:
// the stand-in for the browser, which a test cannot run. LevelDB files whose
// values Blink wraps, and blob files for values Blink moves out, so the store
// under test is Chromium's own format, not a mock of the reader.

// A record of an object store: its value, or null for a deletion. Blink keeps
// a value in place (plain), Snappy-compressed (compressed), or compressed in
// a blob file of its own (blob); version is the V8 format the browser's V8
// writes, which Node's 15 differs from only in buffer sizes.
export type IndexedDBWrite = {
  readonly database: string;
  readonly objectStore: string;
  readonly key: string;
  readonly value: unknown;
  readonly form?: 'plain' | 'compressed' | 'blob';
  readonly version?: number;
};

type Write = readonly [key: Buffer, value: Buffer | null];

export class IndexedDBWriter {
  readonly #directory: string;
  readonly #origin: string;
  readonly #databases = new Map<
    string,
    { id: number; stores: Map<string, number> }
  >();
  #sequence = 1;
  #blob = 0x100;

  // directory is the database's own, <origin>.indexeddb.leveldb.
  constructor(directory: string) {
    this.#directory = directory;
    this.#origin = basename(directory, '.indexeddb.leveldb');
  }

  // The browser having made these writes, all in its log.
  async save(writes: readonly IndexedDBWrite[]): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
    const log = await this.#encode(writes);
    const sequence = this.#take(log.length);
    await writeFile(join(this.#directory, 'CURRENT'), 'MANIFEST-000001\n');
    await writeFile(join(this.#directory, 'MANIFEST-000001'), manifest(0, []));
    await writeFile(
      join(this.#directory, '000003.log'),
      leveldbLog(sequence, log),
    );
  }

  // The browser having compacted the tabled writes into a table, deletions
  // kept there as newer than what they delete, then made the later writes in
  // a new log.
  async compact(
    tabled: readonly IndexedDBWrite[],
    later: readonly IndexedDBWrite[],
  ): Promise<void> {
    await rm(this.#directory, { recursive: true, force: true });
    await mkdir(this.#directory, { recursive: true });
    const table = await this.#encode(tabled);
    const first = this.#take(table.length);
    await writeFile(
      join(this.#directory, '000005.ldb'),
      leveldbTable(
        table.map(([key, value], index) => ({
          key,
          sequence: first + index,
          value,
        })),
      ),
    );
    const log = await this.#encode(later);
    const sequence = this.#take(log.length);
    await writeFile(join(this.#directory, 'CURRENT'), 'MANIFEST-000004\n');
    await writeFile(join(this.#directory, 'MANIFEST-000004'), manifest(6, [5]));
    await writeFile(
      join(this.#directory, '000006.log'),
      leveldbLog(sequence, log),
    );
  }

  #take(count: number): number {
    const sequence = this.#sequence;
    this.#sequence += count;
    return sequence;
  }

  // Each database and object store keeps its id across saves. The store holds
  // only the databases and object stores the writes name, as one a browser
  // deleted, such as a signed-out account's, is gone from it.
  async #encode(writes: readonly IndexedDBWrite[]): Promise<Write[]> {
    const metadata: Write[] = [];
    const records: Write[] = [];
    const named = new Map<string, Set<string>>();
    for (const write of writes) {
      const stores = named.get(write.database) ?? new Set<string>();
      named.set(write.database, stores.add(write.objectStore));
      const database = this.#database(write.database);
      const store =
        database.stores.get(write.objectStore) ?? database.stores.size + 1;
      database.stores.set(write.objectStore, store);
      const key = stringKey(write.key);
      if (write.value === null)
        records.push([
          Buffer.concat([keyPrefix(database.id, store, 1), key]),
          null,
        ]);
      else records.push(...(await this.#value(database.id, store, key, write)));
    }
    for (const [name, { id, stores }] of this.#databases) {
      const storeNames = named.get(name);
      if (storeNames === undefined) continue;
      metadata.push([
        Buffer.concat([
          keyPrefix(0, 0, 0),
          Buffer.of(201),
          withLength(`${this.#origin}@1`),
          withLength(name),
        ]),
        varint(id),
      ]);
      for (const [store, storeId] of stores)
        if (storeNames.has(store))
          metadata.push([
            Buffer.concat([
              keyPrefix(id, 0, 0),
              Buffer.of(50),
              varint(storeId),
              Buffer.of(0),
            ]),
            utf16be(store),
          ]);
    }
    return [...metadata, ...records];
  }

  #database(name: string) {
    const known = this.#databases.get(name);
    if (known !== undefined) return known;
    const database = {
      id: this.#databases.size + 2,
      stores: new Map<string, number>(),
    };
    this.#databases.set(name, database);
    return database;
  }

  async #value(
    database: number,
    store: number,
    key: Buffer,
    { value, form = 'plain', version = 16 }: IndexedDBWrite,
  ): Promise<Write[]> {
    const serialized = envelope(value, version);
    const recordKey = Buffer.concat([keyPrefix(database, store, 1), key]);
    if (form === 'plain')
      return [[recordKey, Buffer.concat([varint(1), serialized])]];
    const compressed = Buffer.concat([
      Buffer.of(0xff, 0x11, 0x02),
      Buffer.from(snappy.compress(serialized)),
    ]);
    if (form === 'compressed')
      return [[recordKey, Buffer.concat([varint(1), compressed])]];
    const number = this.#blob++;
    const path = join(
      this.#directory,
      '..',
      `${this.#origin}.indexeddb.blob`,
      database.toString(16),
      ((number & 0xff00) >> 8).toString(16).padStart(2, '0'),
      number.toString(16),
    );
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, compressed);
    return [
      [
        Buffer.concat([keyPrefix(database, store, 3), key]),
        Buffer.concat([
          Buffer.of(0),
          varint(number),
          withLength('application/vnd.blink-idb-value-wrapper'),
          varint(compressed.length),
        ]),
      ],
      [
        recordKey,
        Buffer.concat([
          varint(1),
          Buffer.of(0xff, 0x11, 0x01),
          varint(compressed.length),
          varint(0),
        ]),
      ],
    ];
  }
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function fixed32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function fixed64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

const prefixed = (bytes: Uint8Array) =>
  Buffer.concat([varint(bytes.length), bytes]);

// A log of one write batch, in 32 KiB blocks; a record that crosses a block
// is split into first, middle and last fragments.
function leveldbLog(sequence: number, writes: readonly Write[]): Buffer {
  const blockSize = 32768;
  const out: Buffer[] = [];
  let offset = 0;
  let payload = Buffer.concat([
    fixed64(BigInt(sequence)),
    fixed32(writes.length),
    ...writes.map(([key, value]) =>
      value === null
        ? Buffer.concat([Buffer.of(0), prefixed(key)])
        : Buffer.concat([Buffer.of(1), prefixed(key), prefixed(value)]),
    ),
  ]);
  let first = true;
  for (;;) {
    const left = blockSize - (offset % blockSize);
    if (left < 7) {
      out.push(Buffer.alloc(left));
      offset += left;
      continue;
    }
    const fragment = payload.subarray(0, left - 7);
    payload = payload.subarray(fragment.length);
    const last = payload.length === 0;
    let type = 3;
    if (first && last) type = 1;
    else if (first) type = 2;
    else if (last) type = 4;
    const header = Buffer.alloc(7);
    header.writeUInt32LE(maskedCrc32c(Buffer.of(type), fragment));
    header.writeUInt16LE(fragment.length, 4);
    header.writeUInt8(type, 6);
    out.push(header, fragment);
    offset += 7 + fragment.length;
    first = false;
    if (last) break;
  }
  return Buffer.concat(out);
}

// A table of one Snappy-compressed data block, its index and a footer. Keys
// are internal keys: the user key, then the sequence shifted left 8 and the
// type, 1 for a value.
function leveldbTable(
  entries: readonly { key: Buffer; sequence: number; value: Buffer | null }[],
): Buffer {
  const block = (pairs: readonly (readonly [Buffer, Buffer])[]) =>
    Buffer.concat([
      ...pairs.map(([key, value]) =>
        Buffer.concat([
          varint(0),
          varint(key.length),
          varint(value.length),
          key,
          value,
        ]),
      ),
      fixed32(0),
      fixed32(1),
    ]);
  const parts: Buffer[] = [];
  let offset = 0;
  const append = (contents: Buffer, compress: boolean) => {
    const stored = compress ? Buffer.from(snappy.compress(contents)) : contents;
    const type = Buffer.of(compress ? 1 : 0);
    const handle = Buffer.concat([varint(offset), varint(stored.length)]);
    parts.push(stored, type, fixed32(maskedCrc32c(stored, type)));
    offset += stored.length + 5;
    return handle;
  };
  // A deletion compaction kept is type 0 with an empty value.
  const internal = entries.map(
    ({ key, sequence, value }) =>
      [
        Buffer.concat([
          key,
          fixed64((BigInt(sequence) << 8n) | (value === null ? 0n : 1n)),
        ]),
        value ?? Buffer.alloc(0),
      ] as const,
  );
  const data = append(block(internal), true);
  const metaindex = append(block([]), false);
  const lastKey = internal.at(-1)?.[0] ?? Buffer.alloc(0);
  const index = append(block([[lastKey, data]]), false);
  const footer = Buffer.alloc(48);
  Buffer.concat([metaindex, index]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  return Buffer.concat([...parts, footer]);
}

// A MANIFEST of one version edit: Chromium's comparator, the first log to
// replay, and the live tables.
function manifest(logNumber: number, tables: readonly number[]): Buffer {
  const edit = Buffer.concat([
    varint(1),
    prefixed(Buffer.from('idb_cmp1')),
    varint(2),
    varint(logNumber),
    ...tables.flatMap((number) => [
      varint(7),
      varint(0),
      varint(number),
      varint(0),
      prefixed(Buffer.alloc(8)),
      prefixed(Buffer.alloc(8)),
    ]),
  ]);
  const header = Buffer.alloc(7);
  header.writeUInt32LE(maskedCrc32c(Buffer.of(1), edit));
  header.writeUInt16LE(edit.length, 4);
  header.writeUInt8(1, 6);
  return Buffer.concat([header, edit]);
}

// IndexedDB's key prefix: one byte packing the byte lengths of the database,
// object store and index ids, then each id in as few bytes as it needs.
function keyPrefix(
  database: number,
  objectStore: number,
  index: number,
): Buffer {
  const int = (value: number) => {
    const bytes: number[] = [];
    let rest = value;
    do {
      bytes.push(rest & 0xff);
      rest >>>= 8;
    } while (rest > 0);
    return Buffer.from(bytes);
  };
  const [d, o, i] = [int(database), int(objectStore), int(index)];
  return Buffer.concat([
    Buffer.of(((d.length - 1) << 5) | ((o.length - 1) << 2) | (i.length - 1)),
    d,
    o,
    i,
  ]);
}

const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();
const withLength = (text: string) =>
  Buffer.concat([varint(text.length), utf16be(text)]);
const stringKey = (text: string) =>
  Buffer.concat([Buffer.of(1), withLength(text)]);

// Blink's envelope (version 21, no trailer) around V8's serialization.
function envelope(value: unknown, version: number): Buffer {
  const serializer = new v8.Serializer();
  serializer.writeHeader();
  serializer.writeValue(value);
  const bytes = serializer.releaseBuffer();
  bytes[1] = version;
  return Buffer.concat([Buffer.of(0xff, 0x15, 0xfe), Buffer.alloc(12), bytes]);
}
