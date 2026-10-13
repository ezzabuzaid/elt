import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __commonJS,
  __toESM
} from "./chunk-ZGXE7NZW.mjs";

// node_modules/snappyjs/snappy_decompressor.js
var require_snappy_decompressor = __commonJS({
  "node_modules/snappyjs/snappy_decompressor.js"(exports) {
    "use strict";
    var WORD_MASK = [0, 255, 65535, 16777215, 4294967295];
    function copyBytes(fromArray, fromPos, toArray, toPos, length) {
      var i;
      for (i = 0; i < length; i++) {
        toArray[toPos + i] = fromArray[fromPos + i];
      }
    }
    function selfCopyBytes(array, pos, offset, length) {
      var i;
      for (i = 0; i < length; i++) {
        array[pos + i] = array[pos - offset + i];
      }
    }
    function SnappyDecompressor(compressed) {
      this.array = compressed;
      this.pos = 0;
    }
    SnappyDecompressor.prototype.readUncompressedLength = function() {
      var result = 0;
      var shift = 0;
      var c, val;
      while (shift < 32 && this.pos < this.array.length) {
        c = this.array[this.pos];
        this.pos += 1;
        val = c & 127;
        if (val << shift >>> shift !== val) {
          return -1;
        }
        result |= val << shift;
        if (c < 128) {
          return result;
        }
        shift += 7;
      }
      return -1;
    };
    SnappyDecompressor.prototype.uncompressToBuffer = function(outBuffer) {
      var array = this.array;
      var arrayLength = array.length;
      var pos = this.pos;
      var outPos = 0;
      var c, len, smallLen;
      var offset;
      while (pos < array.length) {
        c = array[pos];
        pos += 1;
        if ((c & 3) === 0) {
          len = (c >>> 2) + 1;
          if (len > 60) {
            if (pos + 3 >= arrayLength) {
              return false;
            }
            smallLen = len - 60;
            len = array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
            len = (len & WORD_MASK[smallLen]) + 1;
            pos += smallLen;
          }
          if (pos + len > arrayLength) {
            return false;
          }
          copyBytes(array, pos, outBuffer, outPos, len);
          pos += len;
          outPos += len;
        } else {
          switch (c & 3) {
            case 1:
              len = (c >>> 2 & 7) + 4;
              offset = array[pos] + (c >>> 5 << 8);
              pos += 1;
              break;
            case 2:
              if (pos + 1 >= arrayLength) {
                return false;
              }
              len = (c >>> 2) + 1;
              offset = array[pos] + (array[pos + 1] << 8);
              pos += 2;
              break;
            case 3:
              if (pos + 3 >= arrayLength) {
                return false;
              }
              len = (c >>> 2) + 1;
              offset = array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
              pos += 4;
              break;
            default:
              break;
          }
          if (offset === 0 || offset > outPos) {
            return false;
          }
          selfCopyBytes(outBuffer, outPos, offset, len);
          outPos += len;
        }
      }
      return true;
    };
    exports.SnappyDecompressor = SnappyDecompressor;
  }
});

// node_modules/snappyjs/snappy_compressor.js
var require_snappy_compressor = __commonJS({
  "node_modules/snappyjs/snappy_compressor.js"(exports) {
    "use strict";
    var BLOCK_LOG = 16;
    var BLOCK_SIZE = 1 << BLOCK_LOG;
    var MAX_HASH_TABLE_BITS = 14;
    var globalHashTables = new Array(MAX_HASH_TABLE_BITS + 1);
    function hashFunc(key, hashFuncShift) {
      return key * 506832829 >>> hashFuncShift;
    }
    function load32(array, pos) {
      return array[pos] + (array[pos + 1] << 8) + (array[pos + 2] << 16) + (array[pos + 3] << 24);
    }
    function equals32(array, pos1, pos2) {
      return array[pos1] === array[pos2] && array[pos1 + 1] === array[pos2 + 1] && array[pos1 + 2] === array[pos2 + 2] && array[pos1 + 3] === array[pos2 + 3];
    }
    function copyBytes(fromArray, fromPos, toArray, toPos, length) {
      var i;
      for (i = 0; i < length; i++) {
        toArray[toPos + i] = fromArray[fromPos + i];
      }
    }
    function emitLiteral(input, ip, len, output, op) {
      if (len <= 60) {
        output[op] = len - 1 << 2;
        op += 1;
      } else if (len < 256) {
        output[op] = 60 << 2;
        output[op + 1] = len - 1;
        op += 2;
      } else {
        output[op] = 61 << 2;
        output[op + 1] = len - 1 & 255;
        output[op + 2] = len - 1 >>> 8;
        op += 3;
      }
      copyBytes(input, ip, output, op, len);
      return op + len;
    }
    function emitCopyLessThan64(output, op, offset, len) {
      if (len < 12 && offset < 2048) {
        output[op] = 1 + (len - 4 << 2) + (offset >>> 8 << 5);
        output[op + 1] = offset & 255;
        return op + 2;
      } else {
        output[op] = 2 + (len - 1 << 2);
        output[op + 1] = offset & 255;
        output[op + 2] = offset >>> 8;
        return op + 3;
      }
    }
    function emitCopy(output, op, offset, len) {
      while (len >= 68) {
        op = emitCopyLessThan64(output, op, offset, 64);
        len -= 64;
      }
      if (len > 64) {
        op = emitCopyLessThan64(output, op, offset, 60);
        len -= 60;
      }
      return emitCopyLessThan64(output, op, offset, len);
    }
    function compressFragment(input, ip, inputSize, output, op) {
      var hashTableBits = 1;
      while (1 << hashTableBits <= inputSize && hashTableBits <= MAX_HASH_TABLE_BITS) {
        hashTableBits += 1;
      }
      hashTableBits -= 1;
      var hashFuncShift = 32 - hashTableBits;
      if (typeof globalHashTables[hashTableBits] === "undefined") {
        globalHashTables[hashTableBits] = new Uint16Array(1 << hashTableBits);
      }
      var hashTable = globalHashTables[hashTableBits];
      var i;
      for (i = 0; i < hashTable.length; i++) {
        hashTable[i] = 0;
      }
      var ipEnd = ip + inputSize;
      var ipLimit;
      var baseIp = ip;
      var nextEmit = ip;
      var hash, nextHash;
      var nextIp, candidate, skip;
      var bytesBetweenHashLookups;
      var base, matched, offset;
      var prevHash, curHash;
      var flag = true;
      var INPUT_MARGIN = 15;
      if (inputSize >= INPUT_MARGIN) {
        ipLimit = ipEnd - INPUT_MARGIN;
        ip += 1;
        nextHash = hashFunc(load32(input, ip), hashFuncShift);
        while (flag) {
          skip = 32;
          nextIp = ip;
          do {
            ip = nextIp;
            hash = nextHash;
            bytesBetweenHashLookups = skip >>> 5;
            skip += 1;
            nextIp = ip + bytesBetweenHashLookups;
            if (ip > ipLimit) {
              flag = false;
              break;
            }
            nextHash = hashFunc(load32(input, nextIp), hashFuncShift);
            candidate = baseIp + hashTable[hash];
            hashTable[hash] = ip - baseIp;
          } while (!equals32(input, ip, candidate));
          if (!flag) {
            break;
          }
          op = emitLiteral(input, nextEmit, ip - nextEmit, output, op);
          do {
            base = ip;
            matched = 4;
            while (ip + matched < ipEnd && input[ip + matched] === input[candidate + matched]) {
              matched += 1;
            }
            ip += matched;
            offset = base - candidate;
            op = emitCopy(output, op, offset, matched);
            nextEmit = ip;
            if (ip >= ipLimit) {
              flag = false;
              break;
            }
            prevHash = hashFunc(load32(input, ip - 1), hashFuncShift);
            hashTable[prevHash] = ip - 1 - baseIp;
            curHash = hashFunc(load32(input, ip), hashFuncShift);
            candidate = baseIp + hashTable[curHash];
            hashTable[curHash] = ip - baseIp;
          } while (equals32(input, ip, candidate));
          if (!flag) {
            break;
          }
          ip += 1;
          nextHash = hashFunc(load32(input, ip), hashFuncShift);
        }
      }
      if (nextEmit < ipEnd) {
        op = emitLiteral(input, nextEmit, ipEnd - nextEmit, output, op);
      }
      return op;
    }
    function putVarint(value, output, op) {
      do {
        output[op] = value & 127;
        value = value >>> 7;
        if (value > 0) {
          output[op] += 128;
        }
        op += 1;
      } while (value > 0);
      return op;
    }
    function SnappyCompressor(uncompressed2) {
      this.array = uncompressed2;
    }
    SnappyCompressor.prototype.maxCompressedLength = function() {
      var sourceLen = this.array.length;
      return 32 + sourceLen + Math.floor(sourceLen / 6);
    };
    SnappyCompressor.prototype.compressToBuffer = function(outBuffer) {
      var array = this.array;
      var length = array.length;
      var pos = 0;
      var outPos = 0;
      var fragmentSize;
      outPos = putVarint(length, outBuffer, outPos);
      while (pos < length) {
        fragmentSize = Math.min(length - pos, BLOCK_SIZE);
        outPos = compressFragment(array, pos, fragmentSize, outBuffer, outPos);
        pos += fragmentSize;
      }
      return outPos;
    };
    exports.SnappyCompressor = SnappyCompressor;
  }
});

// node_modules/snappyjs/index.js
var require_snappyjs = __commonJS({
  "node_modules/snappyjs/index.js"(exports) {
    "use strict";
    function isNode() {
      if (typeof process === "object") {
        if (typeof process.versions === "object") {
          if (typeof process.versions.node !== "undefined") {
            return true;
          }
        }
      }
      return false;
    }
    function isUint8Array(object) {
      return object instanceof Uint8Array && (!isNode() || !Buffer.isBuffer(object));
    }
    function isArrayBuffer(object) {
      return object instanceof ArrayBuffer;
    }
    function isBuffer(object) {
      if (!isNode()) {
        return false;
      }
      return Buffer.isBuffer(object);
    }
    var SnappyDecompressor = require_snappy_decompressor().SnappyDecompressor;
    var SnappyCompressor = require_snappy_compressor().SnappyCompressor;
    var TYPE_ERROR_MSG = "Argument compressed must be type of ArrayBuffer, Buffer, or Uint8Array";
    function uncompress(compressed, maxLength) {
      if (!isUint8Array(compressed) && !isArrayBuffer(compressed) && !isBuffer(compressed)) {
        throw new TypeError(TYPE_ERROR_MSG);
      }
      var uint8Mode = false;
      var arrayBufferMode = false;
      if (isUint8Array(compressed)) {
        uint8Mode = true;
      } else if (isArrayBuffer(compressed)) {
        arrayBufferMode = true;
        compressed = new Uint8Array(compressed);
      }
      var decompressor = new SnappyDecompressor(compressed);
      var length = decompressor.readUncompressedLength();
      if (length === -1) {
        throw new Error("Invalid Snappy bitstream");
      }
      if (length > maxLength) {
        throw new Error(`The uncompressed length of ${length} is too big, expect at most ${maxLength}`);
      }
      var uncompressed2, uncompressedView;
      if (uint8Mode) {
        uncompressed2 = new Uint8Array(length);
        if (!decompressor.uncompressToBuffer(uncompressed2)) {
          throw new Error("Invalid Snappy bitstream");
        }
      } else if (arrayBufferMode) {
        uncompressed2 = new ArrayBuffer(length);
        uncompressedView = new Uint8Array(uncompressed2);
        if (!decompressor.uncompressToBuffer(uncompressedView)) {
          throw new Error("Invalid Snappy bitstream");
        }
      } else {
        uncompressed2 = Buffer.alloc(length);
        if (!decompressor.uncompressToBuffer(uncompressed2)) {
          throw new Error("Invalid Snappy bitstream");
        }
      }
      return uncompressed2;
    }
    function compress(uncompressed2) {
      if (!isUint8Array(uncompressed2) && !isArrayBuffer(uncompressed2) && !isBuffer(uncompressed2)) {
        throw new TypeError(TYPE_ERROR_MSG);
      }
      var uint8Mode = false;
      var arrayBufferMode = false;
      if (isUint8Array(uncompressed2)) {
        uint8Mode = true;
      } else if (isArrayBuffer(uncompressed2)) {
        arrayBufferMode = true;
        uncompressed2 = new Uint8Array(uncompressed2);
      }
      var compressor = new SnappyCompressor(uncompressed2);
      var maxLength = compressor.maxCompressedLength();
      var compressed, compressedView;
      var length;
      if (uint8Mode) {
        compressed = new Uint8Array(maxLength);
        length = compressor.compressToBuffer(compressed);
      } else if (arrayBufferMode) {
        compressed = new ArrayBuffer(maxLength);
        compressedView = new Uint8Array(compressed);
        length = compressor.compressToBuffer(compressedView);
      } else {
        compressed = Buffer.alloc(maxLength);
        length = compressor.compressToBuffer(compressed);
      }
      if (!compressed.slice) {
        var compressedArray = new Uint8Array(Array.prototype.slice.call(compressed, 0, length));
        if (uint8Mode) {
          return compressedArray;
        } else if (arrayBufferMode) {
          return compressedArray.buffer;
        } else {
          throw new Error("Not implemented");
        }
      }
      return compressed.slice(0, length);
    }
    exports.uncompress = uncompress;
    exports.compress = compress;
  }
});

// packages/codecs/chromium-indexeddb/dist/errors.js
var IndexedDBFormatError = class extends Error {
  name = "IndexedDBFormatError";
  constructor(path, problem, cause) {
    super(`${path} is not a readable Chromium IndexedDB: ${problem}`, {
      cause
    });
  }
};

// packages/codecs/leveldb/dist/crc32c.js
var table = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 2197175160 ^ crc >>> 1 : crc >>> 1;
  return crc >>> 0;
});
function maskedCrc32c(...parts) {
  let crc = 4294967295;
  for (const part of parts)
    for (const byte of part)
      crc = (table[(crc ^ byte) & 255] ?? 0) ^ crc >>> 8;
  crc = (crc ^ 4294967295) >>> 0;
  return (crc >>> 15 | crc << 17) + 2726488792 >>> 0;
}

// packages/codecs/leveldb/dist/errors.js
var LevelDBFormatError = class extends Error {
  name = "LevelDBFormatError";
  constructor(path, problem) {
    super(`${path} is not a readable LevelDB file: ${problem}`);
  }
};

// packages/codecs/leveldb/dist/leveldb.js
import { readFile as readFile2 } from "node:fs/promises";

// packages/codecs/leveldb/dist/byte-reader.js
var ByteReader = class {
  bytes;
  path;
  offset;
  constructor(bytes, path, offset = 0) {
    this.bytes = bytes;
    this.path = path;
    this.offset = offset;
  }
  get done() {
    return this.offset >= this.bytes.length;
  }
  take(length) {
    const end = this.offset + length;
    if (end > this.bytes.length)
      throw new LevelDBFormatError(this.path, `${length} bytes at offset ${this.offset} run past the end`);
    const slice = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }
  byte() {
    return this.take(1)[0] ?? 0;
  }
  fixed32() {
    const bytes = this.take(4);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }
  fixed64() {
    const bytes = this.take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
  }
  // File numbers, sizes and sequence numbers stay far below 2^53.
  varint() {
    const start = this.offset;
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) {
        if (!Number.isSafeInteger(value))
          throw new LevelDBFormatError(this.path, `the varint at offset ${start} exceeds 2^53`);
        return value;
      }
    }
    throw new LevelDBFormatError(this.path, `the varint at offset ${start} runs longer than 64 bits`);
  }
  lengthPrefixed() {
    return this.take(this.varint());
  }
};

// packages/codecs/leveldb/dist/log.js
var blockSize = 32768;
var headerSize = 7;
var full = 1;
var first = 2;
var middle = 3;
var last = 4;
function* logRecords(bytes, path) {
  let fragments = null;
  for (let block2 = 0; block2 < bytes.length; block2 += blockSize) {
    const end = Math.min(block2 + blockSize, bytes.length);
    const reader = new ByteReader(bytes.subarray(0, end), path, block2);
    while (end - reader.offset >= headerSize) {
      const checksum = reader.fixed32();
      const length = reader.byte() | reader.byte() << 8;
      const type = reader.byte();
      if (type === 0 && length === 0)
        break;
      if (reader.offset + length > bytes.length)
        return;
      const payload = reader.take(length);
      if (maskedCrc32c(Uint8Array.of(type), payload) !== checksum)
        throw new LevelDBFormatError(path, `the record at offset ${reader.offset - length - headerSize} fails its checksum`);
      if (type === full)
        yield payload;
      else if (type === first)
        fragments = [payload];
      else if ((type === middle || type === last) && fragments !== null) {
        fragments.push(payload);
        if (type === last) {
          yield Buffer.concat(fragments);
          fragments = null;
        }
      } else
        throw new LevelDBFormatError(path, `record type ${type} at offset ${reader.offset - length - headerSize} is out of order`);
    }
  }
}
function* logEntries(bytes, path) {
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
          value: reader.lengthPrefixed()
        };
      else if (type === 0)
        yield { key, sequence: sequence + index, value: null };
      else
        throw new LevelDBFormatError(path, `write batch entry type ${type}`);
    }
  }
}

// packages/codecs/leveldb/dist/manifest.js
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
var comparator = 1;
var logNumberTag = 2;
var nextFileNumber = 3;
var lastSequence = 4;
var compactPointer = 5;
var deletedFile = 6;
var newFile = 7;
var prevLogNumberTag = 9;
async function liveFiles(directory) {
  const currentPath = join(directory, "CURRENT");
  const current = await readFile(currentPath, "utf8");
  if (!current.endsWith("\n") || !/^MANIFEST-\d+$/.test(current.trimEnd()))
    throw new LevelDBFormatError(currentPath, "it names no MANIFEST");
  const manifestPath = join(directory, current.trimEnd());
  const tables = /* @__PURE__ */ new Set();
  let logNumber = 0;
  let prevLogNumber = 0;
  for (const edit of logRecords(await readFile(manifestPath), manifestPath)) {
    const reader = new ByteReader(edit, manifestPath);
    while (!reader.done) {
      const tag = reader.varint();
      if (tag === comparator)
        reader.lengthPrefixed();
      else if (tag === logNumberTag)
        logNumber = reader.varint();
      else if (tag === prevLogNumberTag)
        prevLogNumber = reader.varint();
      else if (tag === nextFileNumber || tag === lastSequence)
        reader.varint();
      else if (tag === compactPointer) {
        reader.varint();
        reader.lengthPrefixed();
      } else if (tag === deletedFile) {
        reader.varint();
        tables.delete(reader.varint());
      } else if (tag === newFile) {
        reader.varint();
        tables.add(reader.varint());
        reader.varint();
        reader.lengthPrefixed();
        reader.lengthPrefixed();
      } else
        throw new LevelDBFormatError(manifestPath, `version edit tag ${tag}`);
    }
  }
  const names = await readdir(directory);
  const numbered = (extension) => names.flatMap((name) => {
    const match = new RegExp(`^(\\d+)\\.${extension}$`).exec(name);
    return match?.[1] === void 0 ? [] : [[Number(match[1]), name]];
  });
  const tableFiles = new Map([...numbered("sst"), ...numbered("ldb")]);
  return {
    tables: [...tables].sort((a, b) => a - b).map((number) => {
      const name = tableFiles.get(number);
      if (name === void 0)
        throw new LevelDBFormatError(manifestPath, `it lists table ${number}, which is not in ${directory}`);
      return join(directory, name);
    }),
    logs: numbered("log").filter(([number]) => number >= logNumber || number === prevLogNumber).sort(([a], [b]) => a - b).map(([, name]) => join(directory, name))
  };
}

// packages/codecs/leveldb/dist/table.js
var import_snappyjs = __toESM(require_snappyjs(), 1);
var footerSize = 48;
var magic = 0xdb4775248b80fb57n;
var uncompressed = 0;
var snappyCompressed = 1;
function* tableEntries(bytes, path) {
  if (bytes.length < footerSize)
    throw new LevelDBFormatError(path, "the table is shorter than its footer");
  const footer = new ByteReader(bytes, path, bytes.length - footerSize);
  footer.varint();
  footer.varint();
  const index = { offset: footer.varint(), size: footer.varint() };
  footer.offset = bytes.length - 8;
  if (footer.fixed64() !== magic)
    throw new LevelDBFormatError(path, "the footer has no table magic number");
  for (const { value } of blockEntries(block(bytes, path, index), path)) {
    const handle = new ByteReader(value, path);
    const data = { offset: handle.varint(), size: handle.varint() };
    for (const entry of blockEntries(block(bytes, path, data), path))
      yield internalEntry(entry.key, entry.value, path);
  }
}
function block(bytes, path, { offset, size }) {
  const reader = new ByteReader(bytes, path, offset);
  const contents = reader.take(size);
  const type = reader.byte();
  if (maskedCrc32c(contents, Uint8Array.of(type)) !== reader.fixed32())
    throw new LevelDBFormatError(path, `the block at offset ${offset} fails its checksum`);
  if (type === uncompressed)
    return contents;
  if (type === snappyCompressed)
    return import_snappyjs.default.uncompress(contents);
  throw new LevelDBFormatError(path, `the block at offset ${offset} uses compression type ${type}`);
}
function* blockEntries(contents, path) {
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
      throw new LevelDBFormatError(path, `an entry shares ${shared} bytes of a ${previous.length}-byte key`);
    const key = Buffer.concat([
      previous.subarray(0, shared),
      reader.take(unshared)
    ]);
    yield { key, value: reader.take(length) };
    previous = key;
  }
}
function internalEntry(key, value, path) {
  if (key.length < 8)
    throw new LevelDBFormatError(path, "a table key has no sequence number");
  const trailer = new ByteReader(key, path, key.length - 8).fixed64();
  const type = Number(trailer & 0xffn);
  const sequence = Number(trailer >> 8n);
  const user = key.subarray(0, key.length - 8);
  if (type === 1)
    return { key: user, sequence, value };
  if (type === 0)
    return { key: user, sequence, value: null };
  throw new LevelDBFormatError(path, `table entry type ${type}`);
}

// packages/codecs/leveldb/dist/leveldb.js
async function readLevelDB(directory) {
  const { tables, logs } = await liveFiles(directory);
  const newest = /* @__PURE__ */ new Map();
  const keep = (entry) => {
    const id = Buffer.from(entry.key).toString("latin1");
    const seen = newest.get(id);
    if (seen === void 0 || entry.sequence > seen.sequence)
      newest.set(id, entry);
  };
  for (const path of tables)
    for (const entry of tableEntries(await readFile2(path), path))
      keep(entry);
  for (const path of logs)
    for (const entry of logEntries(await readFile2(path), path))
      keep(entry);
  return [...newest.values()].flatMap(({ key, value }) => value === null ? [] : [{ key, value }]);
}

// packages/codecs/v8-serialization/dist/v8-deserializer.js
var oldestVersion = 13;
var newestVersion = 16;
var V8FormatError = class extends Error {
  name = "V8FormatError";
  constructor(offset, problem) {
    super(`V8 serialized data at offset ${offset}: ${problem}`);
  }
};
var regExpFlags = [
  ["g", 1],
  ["i", 2],
  ["m", 4],
  ["y", 8],
  ["u", 16],
  ["s", 32],
  ["d", 128],
  ["v", 256]
];
var viewTypes = {
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
  Q: BigUint64Array
};
var errorPrototypes = {
  E: EvalError,
  R: RangeError,
  F: ReferenceError,
  S: SyntaxError,
  T: TypeError,
  U: URIError
};
function deserializeV8(bytes) {
  return new V8Reader(bytes).read();
}
var V8Reader = class {
  #bytes;
  #offset = 0;
  #version = 0;
  // Every object takes the next id as V8 reads it, so a later reference
  // (^ and an id) finds the same object.
  #objects = [];
  constructor(bytes) {
    this.#bytes = bytes;
  }
  read() {
    if (this.#byte() !== 255)
      throw new V8FormatError(0, "it has no version header");
    this.#version = this.#varint();
    if (this.#version < oldestVersion || this.#version > newestVersion)
      throw new V8FormatError(1, `format version ${this.#version} is outside ${oldestVersion} to ${newestVersion}`);
    return this.#value();
  }
  #fail(problem, offset = this.#offset) {
    throw new V8FormatError(offset, problem);
  }
  #take(length) {
    const end = this.#offset + length;
    if (end > this.#bytes.length)
      this.#fail(`${length} bytes run past the end`);
    const slice = this.#bytes.subarray(this.#offset, end);
    this.#offset = end;
    return slice;
  }
  #byte() {
    return this.#take(1)[0] ?? 0;
  }
  #varint() {
    const start = this.#offset;
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.#byte();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) {
        if (!Number.isSafeInteger(value))
          this.#fail("a varint exceeds 2^53", start);
        return value;
      }
    }
    return this.#fail("a varint runs longer than 64 bits", start);
  }
  #double() {
    const bytes = this.#take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }
  // Padding bytes (0) align two-byte strings; they stand where a tag would.
  #tag() {
    let byte = this.#byte();
    while (byte === 0)
      byte = this.#byte();
    return String.fromCharCode(byte);
  }
  #peekTag() {
    let offset = this.#offset;
    while (this.#bytes[offset] === 0)
      offset++;
    const byte = this.#bytes[offset];
    return byte === void 0 ? "" : String.fromCharCode(byte);
  }
  #remember(object) {
    this.#objects.push(object);
    return object;
  }
  #value() {
    const start = this.#offset;
    const tag = this.#tag();
    switch (tag) {
      case "_":
        return void 0;
      case "0":
        return null;
      case "T":
        return true;
      case "F":
        return false;
      case "I": {
        const zigzag = this.#varint();
        return zigzag >>> 1 ^ -(zigzag & 1);
      }
      case "U":
        return this.#varint();
      case "N":
        return this.#double();
      case "Z":
        return this.#bigint();
      case '"':
        return Buffer.from(this.#take(this.#varint())).toString("latin1");
      case "c":
        return this.#twoByteString();
      case "S":
        return Buffer.from(this.#take(this.#varint())).toString("utf8");
      case "?":
        this.#varint();
        return this.#value();
      case "^": {
        const id = this.#varint();
        if (id >= this.#objects.length)
          this.#fail(`it refers to object ${id} before reading it`, start);
        return this.#view(this.#objects[id]);
      }
      case "o":
        return this.#object();
      case "A":
        return this.#denseArray();
      case "a":
        return this.#sparseArray();
      case "D":
        return this.#remember(new Date(this.#double()));
      case "y":
        return this.#remember(true);
      case "x":
        return this.#remember(false);
      case "n":
        return this.#remember(this.#double());
      case "z":
        return this.#remember(this.#bigint());
      case "s": {
        const id = this.#objects.length;
        this.#objects.push(void 0);
        const value = this.#value();
        this.#objects[id] = value;
        return value;
      }
      case "R":
        return this.#regExp();
      case ";":
        return this.#map();
      case "'":
        return this.#set();
      case "B":
      case "C":
        return this.#view(this.#remember(this.#buffer(this.#varint())));
      case "~": {
        const length = this.#varint();
        const maxLength = this.#varint();
        return this.#view(this.#remember(this.#buffer(length, maxLength)));
      }
      case "r":
        return this.#error();
      default:
        return this.#fail(`tag '${tag}' (0x${tag.charCodeAt(0).toString(16)}) is not a value a store holds`, start);
    }
  }
  #bigint() {
    const bitfield = this.#varint();
    const digits = this.#take(Math.floor(bitfield / 2));
    let value = 0n;
    for (let index = digits.length - 1; index >= 0; index--)
      value = value << 8n | BigInt(digits[index] ?? 0);
    return bitfield & 1 ? -value : value;
  }
  #twoByteString() {
    const length = this.#varint();
    if (length % 2 !== 0)
      this.#fail(`a two-byte string of ${length} bytes`);
    return Buffer.from(this.#take(length)).toString("utf16le");
  }
  #key() {
    const key = this.#value();
    if (typeof key === "string")
      return key;
    if (typeof key === "number")
      return String(key);
    return this.#fail(`a property key of type ${typeof key}`);
  }
  #properties(target, end) {
    let count = 0;
    while (this.#peekTag() !== end) {
      Reflect.set(target, this.#key(), this.#value());
      count++;
    }
    this.#tag();
    return count;
  }
  #checkCount(expected, actual, what) {
    if (expected !== actual)
      this.#fail(`${what} declares ${expected} entries and holds ${actual}`);
  }
  #object() {
    const object = this.#remember({});
    const count = this.#properties(object, "{");
    this.#checkCount(this.#varint(), count, "an object");
    return object;
  }
  #denseArray() {
    const length = this.#varint();
    const array = this.#remember(new Array(length));
    for (let index = 0; index < length; index++) {
      if (this.#peekTag() === "-") {
        this.#tag();
        continue;
      }
      array[index] = this.#value();
    }
    const count = this.#properties(array, "$");
    this.#checkCount(this.#varint(), count, "an array");
    this.#checkCount(this.#varint(), length, "an array length");
    return array;
  }
  #sparseArray() {
    const length = this.#varint();
    const array = this.#remember(new Array(length));
    const count = this.#properties(array, "@");
    this.#checkCount(this.#varint(), count, "a sparse array");
    this.#checkCount(this.#varint(), length, "a sparse array length");
    return array;
  }
  #regExp() {
    const id = this.#objects.length;
    this.#objects.push(void 0);
    const pattern = this.#value();
    if (typeof pattern !== "string")
      this.#fail("a RegExp without a pattern");
    const bits = this.#varint();
    const flags = regExpFlags.filter(([, bit]) => bits & bit).map(([flag]) => flag).join("");
    const regExp = new RegExp(pattern, flags);
    this.#objects[id] = regExp;
    return regExp;
  }
  #map() {
    const map = this.#remember(/* @__PURE__ */ new Map());
    while (this.#peekTag() !== ":")
      map.set(this.#value(), this.#value());
    this.#tag();
    this.#checkCount(this.#varint(), map.size * 2, "a Map");
    return map;
  }
  #set() {
    const set = this.#remember(/* @__PURE__ */ new Set());
    while (this.#peekTag() !== ",")
      set.add(this.#value());
    this.#tag();
    this.#checkCount(this.#varint(), set.size, "a Set");
    return set;
  }
  #buffer(length, maxByteLength) {
    const buffer = maxByteLength === void 0 ? new ArrayBuffer(length) : new ArrayBuffer(length, { maxByteLength });
    new Uint8Array(buffer).set(this.#take(length));
    return buffer;
  }
  // A view over a buffer follows the buffer itself, or a reference to it.
  #view(value) {
    if (!(value instanceof ArrayBuffer) || this.#peekTag() !== "V")
      return value;
    this.#tag();
    const start = this.#offset;
    const type = String.fromCharCode(this.#varint());
    const byteOffset = this.#varint();
    const byteLength = this.#varint();
    if (this.#version >= 14)
      this.#varint();
    if (type === "?")
      return this.#remember(new DataView(value, byteOffset, byteLength));
    const View = Object.entries(viewTypes).find(([name]) => name === type)?.[1];
    if (View === void 0)
      this.#fail(`view type '${type}'`, start);
    return this.#remember(new View(value, byteOffset, byteLength / View.BYTES_PER_ELEMENT));
  }
  #error() {
    const id = this.#objects.length;
    this.#objects.push(void 0);
    let Prototype = Error;
    let message;
    let stack;
    let cause;
    let hasCause = false;
    for (; ; ) {
      const tag = this.#tag();
      if (tag === ".")
        break;
      const prototype = Object.entries(errorPrototypes).find(([name]) => name === tag)?.[1];
      if (prototype !== void 0)
        Prototype = prototype;
      else if (tag === "m")
        message = this.#string();
      else if (tag === "s")
        stack = this.#string();
      else if (tag === "c") {
        cause = this.#value();
        hasCause = true;
      } else
        this.#fail(`error field '${tag}'`);
    }
    const error = new Prototype(message, hasCause ? { cause } : void 0);
    if (stack !== void 0)
      error.stack = String(stack);
    this.#objects[id] = error;
    return error;
  }
  #string() {
    const value = this.#value();
    if (typeof value !== "string")
      this.#fail("a string field holds no string");
    return value;
  }
};

// packages/codecs/chromium-indexeddb/dist/byte-reader.js
var ByteReader2 = class {
  bytes;
  path;
  offset = 0;
  constructor(bytes, path) {
    this.bytes = bytes;
    this.path = path;
  }
  get done() {
    return this.offset >= this.bytes.length;
  }
  fail(problem) {
    throw new IndexedDBFormatError(this.path, problem);
  }
  take(length) {
    const end = this.offset + length;
    if (end > this.bytes.length)
      this.fail(`${length} bytes at offset ${this.offset} run past the end`);
    const slice = this.bytes.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }
  byte() {
    return this.take(1)[0] ?? 0;
  }
  rest() {
    return this.take(this.bytes.length - this.offset);
  }
  // Unsigned LEB128; Blink's own varints in a wrapped value read the same.
  varint() {
    const start = this.offset;
    let value = 0;
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) {
        if (!Number.isSafeInteger(value))
          this.fail(`the varint at offset ${start} exceeds 2^53`);
        return value;
      }
    }
    return this.fail(`the varint at offset ${start} runs longer than 64 bits`);
  }
  // A little-endian integer in as few bytes as it needs.
  int(length) {
    let value = 0;
    for (const [index, byte] of this.take(length).entries())
      value += byte * 2 ** (8 * index);
    return value;
  }
  double() {
    const bytes = this.take(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }
  // UTF-16BE code units: the rest of the slice, or a counted run of them.
  string(units = (this.bytes.length - this.offset) / 2) {
    return Buffer.from(this.take(units * 2)).swap16().toString("utf16le");
  }
  stringWithLength() {
    return this.string(this.varint());
  }
};

// packages/codecs/chromium-indexeddb/dist/key-coding.js
function readPrefix(reader) {
  const lengths = reader.byte();
  return {
    database: reader.int((lengths >> 5) + 1),
    objectStore: reader.int((lengths >> 2 & 7) + 1),
    index: reader.int((lengths & 3) + 1)
  };
}
var stringKey = 1;
var dateKey = 2;
var numberKey = 3;
var arrayKey = 4;
var binaryKey = 6;
function readKey(reader) {
  const type = reader.byte();
  if (type === stringKey)
    return reader.stringWithLength();
  if (type === dateKey)
    return new Date(reader.double());
  if (type === numberKey)
    return reader.double();
  if (type === binaryKey)
    return reader.take(reader.varint()).slice();
  if (type === arrayKey)
    return Array.from({ length: reader.varint() }, () => readKey(reader));
  return reader.fail(`key type ${type}`);
}

// packages/codecs/chromium-indexeddb/dist/value-wrapping.js
var import_snappyjs2 = __toESM(require_snappyjs(), 1);
import { readFile as readFile3 } from "node:fs/promises";
import { join as join2 } from "node:path";
var wrapperVersion = 17;
var replacedWithBlob = 1;
var compressedWithSnappy = 2;
var firstEnvelope = 16;
var firstTrailer = 21;
var trailerOffsetTag = 254;
async function unwrapValue(bytes, externalObjects, blobDirectory, database, path) {
  const reader = new ByteReader2(bytes, path);
  if (bytes[0] === 255 && bytes[1] === wrapperVersion) {
    if (bytes[2] === replacedWithBlob) {
      reader.offset = 3;
      const size = reader.varint();
      const index = reader.varint();
      const object = externalObjects[index];
      if (object === void 0 || object === null)
        return reader.fail(`the value names blob ${index}, which it does not list`);
      const blob = await readFile3(blobPath(blobDirectory, database, object.blobNumber));
      if (blob.length !== size)
        return reader.fail(`blob ${object.blobNumber} holds ${blob.length} bytes, not ${size}`);
      return unwrapValue(blob, [], blobDirectory, database, path);
    }
    if (bytes[2] === compressedWithSnappy)
      return deserialize(import_snappyjs2.default.uncompress(bytes.subarray(3)), path);
  }
  return deserialize(bytes, path);
}
function blobPath(directory, database, number) {
  return join2(directory, database.toString(16), ((number & 65280) >> 8).toString(16).padStart(2, "0"), number.toString(16));
}
function deserialize(bytes, path) {
  const reader = new ByteReader2(bytes, path);
  if (reader.byte() !== 255)
    return reader.fail("the value has no version");
  const version = reader.varint();
  if (version < firstEnvelope)
    return deserializeV8(bytes);
  let end = bytes.length;
  if (version >= firstTrailer) {
    if (reader.byte() !== trailerOffsetTag)
      return reader.fail("the envelope has no trailer offset");
    const trailer = reader.take(12);
    const view = new DataView(trailer.buffer, trailer.byteOffset, 12);
    const offset = Number(view.getBigUint64(0));
    if (offset !== 0)
      end = offset;
  }
  return deserializeV8(bytes.subarray(reader.offset, end));
}
function readExternalObjects(bytes, path) {
  const reader = new ByteReader2(bytes, path);
  const objects = [];
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

// packages/codecs/chromium-indexeddb/dist/indexeddb.js
var databaseName = 201;
var objectStoreMetadata = 50;
var objectStoreName = 0;
var recordsIndex = 1;
var blobsIndex = 3;
async function readIndexedDB(directory) {
  try {
    return await read(directory);
  } catch (error) {
    if (error instanceof LevelDBFormatError || error instanceof V8FormatError)
      throw new IndexedDBFormatError(directory, error.message, error);
    throw error;
  }
}
async function read(directory) {
  const blobDirectory = directory.replace(/\.leveldb\/?$/, ".blob");
  const databases = /* @__PURE__ */ new Map();
  const storeNames = /* @__PURE__ */ new Map();
  const stored = [];
  const blobEntries = /* @__PURE__ */ new Map();
  for (const entry of await readLevelDB(directory)) {
    const reader = new ByteReader2(entry.key, directory);
    const { database, objectStore, index } = readPrefix(reader);
    if (database === 0) {
      if (reader.byte() !== databaseName)
        continue;
      const origin = reader.stringWithLength();
      const name = reader.stringWithLength();
      const id = new ByteReader2(entry.value, directory).int(entry.value.length);
      databases.set(id, { origin, name });
    } else if (objectStore === 0) {
      if (reader.byte() !== objectStoreMetadata)
        continue;
      const store = storeId(database, reader.varint());
      if (reader.byte() !== objectStoreName)
        continue;
      storeNames.set(store, new ByteReader2(entry.value, directory).string());
    } else if (index === recordsIndex)
      stored.push({
        database,
        store: storeId(database, objectStore),
        key: reader.rest(),
        value: entry.value
      });
    else if (index === blobsIndex)
      blobEntries.set(recordId(storeId(database, objectStore), reader.rest()), entry.value);
  }
  const records = /* @__PURE__ */ new Map();
  for (const { database, store, key, value } of stored) {
    const reader = new ByteReader2(value, directory);
    reader.varint();
    const blobs = blobEntries.get(recordId(store, key));
    const record = {
      key: readKey(new ByteReader2(key, directory)),
      value: await unwrapValue(reader.rest(), blobs === void 0 ? [] : readExternalObjects(blobs, directory), blobDirectory, database, directory)
    };
    const list = records.get(store);
    if (list === void 0)
      records.set(store, [record]);
    else
      list.push(record);
  }
  return [...databases].map(([database, { origin, name }]) => ({
    origin,
    name,
    objectStores: [...storeNames].filter(([store]) => store.startsWith(`${database}:`)).map(([store, storeName]) => ({
      name: storeName,
      records: records.get(store) ?? []
    }))
  }));
}
function storeId(database, objectStore) {
  return `${database}:${objectStore}`;
}
function recordId(store, key) {
  return `${store}:${Buffer.from(key).toString("hex")}`;
}

export {
  IndexedDBFormatError,
  readIndexedDB
};
