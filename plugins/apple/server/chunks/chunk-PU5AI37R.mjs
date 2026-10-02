import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// apps/apple/connectors/dist/apps/apple-app.js
import { mkdirSync } from "node:fs";
import { join as join2 } from "node:path";

// packages/elt/dist/core/deduplication.js
var Deduplication = class {
  stream;
  primaryKey;
  // Absent when the newest extraction always wins (dedupPolicy replace).
  cursorField;
  constructor(stream, primaryKey, cursorField) {
    this.stream = stream;
    this.cursorField = cursorField;
    if (!Array.isArray(primaryKey) || primaryKey.length === 0 || new Set(primaryKey).size !== primaryKey.length)
      throw new TypeError("Deduplication requires distinct primaryKey fields");
    this.primaryKey = Object.freeze([...primaryKey]);
    for (const field of this.primaryKey)
      this.type(field);
    if (cursorField !== void 0 && !["string", "number", "integer"].includes(this.type(cursorField)))
      throw new TypeError("Deduplication cursor must be text or numeric");
    Object.freeze(this);
  }
  type(field) {
    const properties = this.stream.jsonSchema.properties;
    if (typeof field !== "string" || !field || properties === null || typeof properties !== "object" || !Object.hasOwn(properties, field))
      throw new TypeError(`Schema must describe key/cursor field ${field}`);
    const schema = Reflect.get(properties, field);
    const type = schema !== null && typeof schema === "object" ? Reflect.get(schema, "type") : void 0;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean")
      throw new TypeError(`Key/cursor field ${field} requires one non-null scalar schema type`);
    return type;
  }
  value(record, field) {
    if (record === null || typeof record !== "object" || !Object.hasOwn(record, field))
      throw new TypeError(`Record is missing key/cursor field ${field}`);
    const value = Reflect.get(record, field);
    const type = this.type(field);
    if (type === "string" && typeof value === "string" && value.isWellFormed() || type === "boolean" && typeof value === "boolean" || type === "number" && typeof value === "number" && Number.isFinite(value) || type === "integer" && typeof value === "number" && Number.isSafeInteger(value))
      return value;
    throw new TypeError(`Key/cursor field ${field} requires non-null ${type}`);
  }
  key(record) {
    return JSON.stringify(this.primaryKey.map((field) => this.value(record, field)));
  }
  cursor(record) {
    if (this.cursorField === void 0)
      throw new TypeError("Deduplication has no cursor field");
    const value = this.value(record, this.cursorField);
    if (typeof value === "boolean")
      throw new TypeError("Cursor cannot be boolean");
    return value;
  }
  newer(record, previous) {
    const value = this.cursor(record);
    const saved = this.cursor(previous);
    if (typeof value === "string" && typeof saved === "string")
      return Buffer.compare(Buffer.from(value), Buffer.from(saved)) > 0;
    return value > saved;
  }
};

// packages/elt/dist/core/document-parser.js
var DocumentParser = class {
  identity;
  constructor(identity) {
    this.identity = identity;
    if (!identity || identity.includes("\0"))
      throw new TypeError("A parser requires a stable identity");
  }
};

// packages/elt/dist/core/file-storage.js
var FileStorage = class {
};

// packages/elt/dist/core/file-read.js
var FileReference = class _FileReference {
  stream;
  storage;
  constructor(stream, storage) {
    this.stream = stream;
    this.storage = storage;
    if (storage !== void 0 && (!(storage instanceof FileStorage) || typeof storage.identity !== "string" || storage.identity.length === 0 || !storage.identity.isWellFormed() || storage.identity.includes("\0")))
      throw new TypeError("File storage requires a stable text identity");
    Object.freeze(this);
  }
  store(storage) {
    return new _FileReference(this.stream, storage);
  }
};
var FileRead = class {
  name;
  file;
  parser;
  parserIdentity;
  storageIdentity;
  constructor(name, file, parser) {
    this.name = name;
    this.file = file;
    this.parser = parser;
    if (!name || name.includes("\0"))
      throw new TypeError("Invalid file field name");
    if (!(file instanceof FileReference))
      throw new TypeError("File extraction requires a source file reference");
    if (parser !== void 0 && !(parser instanceof DocumentParser))
      throw new TypeError("parser must be a DocumentParser");
    if (parser !== void 0 && file.storage !== void 0)
      throw new TypeError("Select parsing and storage as separate file fields");
    this.parserIdentity = parser?.identity;
    this.storageIdentity = file.storage?.identity;
    Object.freeze(this);
  }
  validate(stream) {
    if (this.file.stream.name !== stream.name)
      throw new TypeError("File reference belongs to another stream");
    if (this.file.stream.supportsFileTransfer !== true || stream.supportsFileTransfer !== true)
      throw new TypeError(`Stream ${stream.name} does not support file extraction`);
    if (this.parser?.identity !== this.parserIdentity)
      throw new TypeError("Parser identity changed after configuration");
    if (this.file.storage?.identity !== this.storageIdentity)
      throw new TypeError("File storage identity changed after configuration");
    const { properties } = stream.jsonSchema;
    if (stream.jsonSchema.type !== "object" || properties === null || typeof properties !== "object" || Array.isArray(properties))
      throw new TypeError("File extraction requires an object metadata schema");
    if (Object.keys(properties).some((name) => name.toLowerCase() === this.name.toLowerCase()))
      throw new TypeError("File field collides with source metadata");
  }
  toJSON() {
    return {
      name: this.name,
      stream: this.file.stream.name,
      parser: this.parserIdentity,
      storage: this.storageIdentity
    };
  }
  get outputType() {
    return this.parser !== void 0 || this.file.storage !== void 0 ? "text" : "bytes";
  }
};

// packages/elt/dist/core/stream.js
var Stream = class {
  name;
  jsonSchema;
  primaryKey;
  supportedSyncModes;
  supportsFileTransfer;
  // Incremental progress is opaque source state, so copies select no cursorField.
  sourceDefinedCursor;
  // Incremental reads may emit DELETE messages keyed by primaryKey.
  emitsDeletes;
  // The source reads the stream once per value of these primaryKey fields and
  // keeps each partition's state apart; every record carries its partition.
  partitionKey;
  constructor({ name, jsonSchema, primaryKey = [], supportedSyncModes, supportsFileTransfer, sourceDefinedCursor, emitsDeletes, partitionKey }) {
    if (!name || name.includes("\0"))
      throw new TypeError("Invalid stream name");
    if (!Array.isArray(supportedSyncModes) || supportedSyncModes.length === 0 || !supportedSyncModes.every((mode) => mode === "full_refresh" || mode === "incremental") || new Set(supportedSyncModes).size !== supportedSyncModes.length)
      throw new TypeError("A stream requires distinct supported sync modes");
    this.name = name;
    if (supportsFileTransfer !== void 0 && supportsFileTransfer !== true)
      throw new TypeError("supportsFileTransfer must be true when declared");
    this.supportsFileTransfer = supportsFileTransfer;
    if (sourceDefinedCursor !== void 0 && sourceDefinedCursor !== true)
      throw new TypeError("sourceDefinedCursor must be true when declared");
    if (emitsDeletes !== void 0 && emitsDeletes !== true)
      throw new TypeError("emitsDeletes must be true when declared");
    if ((sourceDefinedCursor || emitsDeletes) && !supportedSyncModes.includes("incremental"))
      throw new TypeError("A source-defined cursor or deletions require incremental support");
    if (emitsDeletes && primaryKey.length === 0)
      throw new TypeError("A stream that emits deletions requires a primaryKey");
    this.sourceDefinedCursor = sourceDefinedCursor;
    this.emitsDeletes = emitsDeletes;
    this.jsonSchema = structuredClone(jsonSchema);
    const seen = /* @__PURE__ */ new WeakSet();
    const freeze = (value) => {
      if (value === null || typeof value !== "object" || seen.has(value))
        return;
      seen.add(value);
      for (const child of Object.values(value))
        freeze(child);
      Object.freeze(value);
    };
    freeze(this.jsonSchema);
    this.primaryKey = Object.freeze([...primaryKey]);
    this.supportedSyncModes = Object.freeze([...supportedSyncModes]);
    if (partitionKey !== void 0) {
      if (!Array.isArray(partitionKey) || partitionKey.length === 0 || new Set(partitionKey).size !== partitionKey.length || !partitionKey.every((field) => primaryKey.includes(field)))
        throw new TypeError("partitionKey fields must be distinct members of primaryKey");
      this.partitionKey = Object.freeze([...partitionKey]);
      new Deduplication(this, this.partitionKey);
    }
    Object.freeze(this);
  }
  get file() {
    if (this.supportsFileTransfer !== true)
      throw new TypeError(`Stream ${this.name} does not support file extraction`);
    return new FileReference(this);
  }
};

// packages/elt/dist/core/catalog.js
var Catalog = class _Catalog {
  streams;
  constructor(streams) {
    this.streams = Object.freeze(Array.from(streams));
    if (!this.streams.every((stream) => stream instanceof Stream))
      throw new TypeError("A catalog requires stream descriptions");
    if (new Set(this.streams.map((stream) => stream.name)).size !== this.streams.length)
      throw new TypeError("A catalog cannot contain duplicate stream names");
    Object.freeze(this);
  }
  get(name) {
    const stream = this.streams.find((stream2) => stream2.name === name);
    if (!stream)
      throw new TypeError(`Unknown stream: ${name}`);
    return stream;
  }
  select(streams) {
    return new _Catalog(Array.from(streams, (stream) => this.get(stream.name)));
  }
};

// packages/elt/dist/core/copy-configuration.js
var CopyConfiguration = class {
  stream;
  fileReads;
  syncMode;
  destinationSyncMode;
  cursorField;
  primaryKey;
  // Set only for deduplicating loads; cursor_newer unless the copy selects replace.
  dedupPolicy;
  constructor(from, { syncMode, destinationSyncMode, cursorField, primaryKey, dedupPolicy }, fileReads = []) {
    if (!(from instanceof Stream))
      throw new TypeError("Copy requires a stream description");
    if (!Array.isArray(fileReads) || !fileReads.every((read) => read instanceof FileRead))
      throw new TypeError("Copy requires FileRead declarations");
    if (new Set(fileReads.map((read) => read.name.toLowerCase())).size !== fileReads.length)
      throw new TypeError("Duplicate file field names");
    if (typeof syncMode !== "string" || typeof destinationSyncMode !== "string")
      throw new TypeError("Both syncMode and destinationSyncMode are required");
    if (primaryKey !== void 0 && !Array.isArray(primaryKey))
      throw new TypeError("primaryKey must be an array of field names");
    if (primaryKey !== void 0 && from.primaryKey.length > 0)
      throw new TypeError(`Stream ${from.name} defines its own primary key; omit primaryKey`);
    const deduplicating = destinationSyncMode === "append_dedup" || destinationSyncMode === "overwrite_dedup";
    this.stream = from;
    this.fileReads = Object.freeze([...fileReads]);
    this.syncMode = syncMode;
    this.destinationSyncMode = destinationSyncMode;
    this.cursorField = cursorField;
    const key = deduplicating && from.primaryKey.length > 0 ? from.primaryKey : primaryKey;
    this.primaryKey = key === void 0 ? void 0 : Object.freeze([...key]);
    this.dedupPolicy = deduplicating ? dedupPolicy ?? (from.sourceDefinedCursor ? "replace" : "cursor_newer") : dedupPolicy;
    Object.freeze(this);
  }
  validate(stream) {
    if (!this.stream.supportedSyncModes.includes(this.syncMode) || !stream.supportedSyncModes.includes(this.syncMode))
      throw new TypeError(`Stream ${stream.name} does not support ${this.syncMode}`);
    this.validateSelection();
    for (const read of this.fileReads)
      read.validate(stream);
  }
  validateSelection() {
    for (const read of this.fileReads)
      read.validate(this.stream);
    const { syncMode, destinationSyncMode, cursorField, primaryKey, dedupPolicy } = this;
    if (syncMode !== "full_refresh" && syncMode !== "incremental")
      throw new TypeError(`Unsupported syncMode: ${syncMode}`);
    if (syncMode === "incremental" && (destinationSyncMode === "overwrite" || destinationSyncMode === "overwrite_dedup"))
      throw new TypeError("Incremental extraction cannot use overwrite loading");
    if (syncMode === "full_refresh" && destinationSyncMode === "append_dedup")
      throw new TypeError("Full refresh deduplication requires overwrite_dedup");
    const { sourceDefinedCursor, emitsDeletes } = this.stream;
    if (sourceDefinedCursor && cursorField !== void 0)
      throw new TypeError(`Stream ${this.stream.name} defines its own cursor; omit cursorField`);
    if (syncMode === "incremental" && !sourceDefinedCursor && (typeof cursorField !== "string" || !cursorField))
      throw new TypeError("Incremental extraction requires cursorField");
    if (emitsDeletes && syncMode === "incremental" && destinationSyncMode !== "append_dedup")
      throw new TypeError(`Stream ${this.stream.name} emits deletions; incremental copies require append_dedup`);
    if (dedupPolicy !== void 0 && dedupPolicy !== "cursor_newer" && dedupPolicy !== "replace")
      throw new TypeError(`Unsupported dedupPolicy: ${dedupPolicy}`);
    if (destinationSyncMode === "append_dedup" || destinationSyncMode === "overwrite_dedup") {
      if (primaryKey === void 0)
        throw new TypeError(`Stream ${this.stream.name} declares no primary key; select primaryKey`);
      if (dedupPolicy === "cursor_newer" && cursorField === void 0)
        throw new TypeError(sourceDefinedCursor ? `Stream ${this.stream.name} has no cursor field to compare; deduplicate with dedupPolicy 'replace'` : "cursor_newer deduplication requires cursorField");
      new Deduplication(this.stream, primaryKey, cursorField);
      if (dedupPolicy === "cursor_newer" && cursorField !== void 0 && primaryKey.includes(cursorField))
        throw new TypeError(`Cursor field ${cursorField} is part of the primary key, so cursor_newer can never update a conflicting row; select dedupPolicy 'replace' to let the newest extraction win`);
    } else {
      if (primaryKey !== void 0)
        throw new TypeError("Select primaryKey only for deduplication loading");
      if (dedupPolicy !== void 0)
        throw new TypeError("Select dedupPolicy only for deduplication loading");
    }
    if (syncMode === "full_refresh" && destinationSyncMode !== "overwrite_dedup" && cursorField !== void 0)
      throw new TypeError("Full refresh append/overwrite does not use cursorField");
  }
  deduplication() {
    if (this.primaryKey === void 0)
      throw new TypeError("Deduplication requires a primaryKey");
    return new Deduplication(this.stream, this.primaryKey, this.cursorField);
  }
};

// packages/elt/dist/core/file-content.js
import { open } from "node:fs/promises";
var FileContent = class {
  path;
  constructor(path) {
    this.path = path;
    Object.freeze(this);
  }
  async *chunks(size) {
    var _stack = [];
    try {
      if (!Number.isSafeInteger(size) || size <= 0)
        throw new TypeError("Chunk size must be a positive integer");
      const file = __using(_stack, await open(this.path), true);
      let remaining = (await file.stat()).size;
      while (remaining > 0) {
        const chunk = new Uint8Array(Math.min(size, remaining));
        const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0)
          throw new Error(`File ${this.path} shrank while it was read`);
        remaining -= bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
};

// packages/elt/dist/core/file-transfer.js
var FileTransfer = class {
  reads;
  target;
  writer;
  constructor(reads, target, writer) {
    this.reads = reads;
    this.target = target;
    this.writer = writer;
  }
  scope(read) {
    return JSON.stringify({
      target: this.target,
      writer: this.writer,
      field: read.name
    });
  }
  async record(record) {
    let data = record;
    for (const read of this.reads) {
      const storage = read.file.storage;
      if (storage === void 0)
        continue;
      const content = Reflect.get(Object(data), read.name);
      if (content === null)
        continue;
      if (!(content instanceof FileContent))
        throw new TypeError("Stored files require source file content");
      const reference = await storage.save(this.scope(read), content);
      if (typeof reference !== "string" || !reference || reference.includes("\0") || !reference.isWellFormed())
        throw new TypeError("File storage must return a nonempty text reference");
      data = { ...Object(data), [read.name]: reference };
    }
    return data;
  }
  async reconcile(values) {
    for (const read of this.reads) {
      const storage = read.file.storage;
      if (storage === void 0)
        continue;
      const references = /* @__PURE__ */ new Set();
      for await (const value of values(read.name)) {
        if (value === null)
          continue;
        if (typeof value !== "string")
          throw new TypeError("Stored file references must be text or null");
        references.add(value);
      }
      await storage.retain(this.scope(read), references);
    }
  }
};

// packages/elt/dist/core/target.js
var Target = class {
  fileReads;
  constructor(fileReads = []) {
    if (!Array.isArray(fileReads) || !fileReads.every((read) => read instanceof FileRead))
      throw new TypeError("Targets require FileRead declarations");
    const names = fileReads.map((read) => read.name.toLowerCase());
    if (new Set(names).size !== names.length)
      throw new TypeError("Duplicate file field names");
    this.fileReads = Object.freeze([...fileReads]);
  }
};

// packages/elt/dist/core/copy.js
function describeFailures({ copy, failures }) {
  return failures.map(({ partition, error }) => `${copy.id ?? copy.from.name}${partition === null ? "" : ` ${JSON.stringify(partition)}`}: ${error instanceof Error ? error.message : String(error)}`).join("; ");
}
var Copy = class {
  configuration;
  to;
  id;
  constructor(from, to, modes = {
    syncMode: "full_refresh",
    destinationSyncMode: "overwrite"
  }) {
    if (!(to instanceof Target))
      throw new TypeError("Copy requires a destination target");
    this.configuration = new CopyConfiguration(from, modes, to.fileReads);
    this.to = to;
    if (modes.id !== void 0 && (!modes.id || modes.id.includes("\0")))
      throw new TypeError("Copy id must be nonempty text");
    this.id = modes.id;
    Object.freeze(this);
  }
  get from() {
    return this.configuration.stream;
  }
  // The target's writer: the declared id names the replication; without one,
  // the source and stream do.
  writer(source) {
    return JSON.stringify(this.id !== void 0 ? { copy: this.id } : { source: source.identity, stream: this.from.name });
  }
  validate(source, destination, checkpoints) {
    source.validate(this.configuration);
    destination.validate(this.configuration, this.to);
    if (this.configuration.syncMode === "incremental" && (this.id === void 0 || checkpoints === void 0))
      throw new TypeError("Incremental copies require a stable id and checkpoint store");
  }
  // Empties the target and removes this copy's checkpoint together, so the
  // next run reloads from scratch.
  async clear(source, destination, checkpoints) {
    this.validate(source, destination, checkpoints);
    const files = new FileTransfer(this.configuration.fileReads, destination.identity(this.to), this.writer(source));
    const drop = () => destination.clear(this.configuration, this.to, this.writer(source), (values) => files.reconcile(values));
    if (this.id !== void 0 && checkpoints !== void 0)
      await checkpoints.clear(this.id, drop);
    else
      await drop();
  }
};

// packages/elt/dist/core/connection.js
var Connection = class {
  name;
  source;
  destination;
  checkpoints;
  steps;
  constructor({ name, source, destination, steps, checkpoints }) {
    if (!name.trim() || name.includes("\0"))
      throw new TypeError("A connection requires a name");
    if (!steps.every((step) => step instanceof Copy))
      throw new TypeError("Connection steps must be Copy declarations");
    this.name = name;
    this.source = source;
    this.destination = destination;
    this.checkpoints = checkpoints;
    this.steps = Object.freeze([...steps]);
    Object.freeze(this);
  }
  validate() {
    const streams = this.steps.map((copy) => copy.from.name);
    if (new Set(streams).size !== streams.length)
      throw new TypeError(`Connection ${this.name} copies each stream once`);
    for (const copy of this.steps)
      copy.validate(this.source, this.destination, this.checkpoints);
  }
};

// packages/elt/dist/core/destination.js
import { isDeepStrictEqual } from "node:util";
var Destination = class {
  // Validate declarations without storage I/O; destinations check their own targets.
  validate(configuration, target) {
    this.createWriter(configuration, target);
  }
  validateConfiguration(configuration, target) {
    configuration.validateSelection();
    if (!isDeepStrictEqual(configuration.fileReads, target.fileReads))
      throw new TypeError("Copy file reads must match the destination target");
    if (!this.supportedDestinationSyncModes.includes(configuration.destinationSyncMode))
      throw new TypeError(`Destination does not support ${configuration.destinationSyncMode}`);
  }
  async clear(configuration, target, writer, committed) {
    await this.createWriter(configuration, target).clear(writer, committed);
  }
};

// packages/elt/dist/core/formats.js
function isTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isCalendarDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isTimestamp(`${value}T00:00:00.000Z`);
}

// packages/elt/dist/core/interleave.js
async function* interleave(generators, concurrency) {
  const waiting = [...generators];
  const reading = /* @__PURE__ */ new Map();
  const next = (generator) => reading.set(generator, generator.next().then((result) => ({ generator, result })));
  const start = () => {
    const generator = waiting.shift();
    if (generator !== void 0)
      next(generator);
  };
  try {
    while (reading.size < concurrency && waiting.length > 0)
      start();
    while (reading.size > 0) {
      const { generator, result } = await Promise.race(reading.values());
      if (result.done) {
        reading.delete(generator);
        start();
        continue;
      }
      yield result.value;
      reading.delete(generator);
      next(generator);
    }
  } finally {
    for (const [generator, pending] of reading) {
      await pending.catch(() => void 0);
      await generator.return(void 0);
    }
    for (const generator of waiting)
      await generator.return(void 0);
  }
}

// packages/elt/dist/core/replication.js
import { isDeepStrictEqual as isDeepStrictEqual2 } from "node:util";

// packages/elt/dist/core/partition.js
function partitionIdentity(stream) {
  if (stream.partitionKey === void 0)
    throw new TypeError(`Stream ${stream.name} is not partitioned`);
  return new Deduplication(stream, stream.partitionKey);
}
function assertPartitions(stream, partitions) {
  const identity = partitionIdentity(stream);
  if (!Array.isArray(partitions) || partitions.length === 0)
    throw new TypeError(`Stream ${stream.name} requires at least one partition`);
  const keys = /* @__PURE__ */ new Set();
  for (const partition of partitions) {
    const { key } = readPartition(identity, partition);
    if (keys.has(key))
      throw new TypeError(`Stream ${stream.name} lists partition ${key} twice`);
    keys.add(key);
  }
}
function readPartition(identity, value) {
  if (value === null || typeof value !== "object" || Object.keys(value).length !== identity.primaryKey.length)
    throw new TypeError(`Stream ${identity.stream.name} partitions carry exactly ${JSON.stringify(identity.primaryKey)}`);
  return {
    key: identity.key(value),
    partition: Object.freeze(Object.fromEntries(identity.primaryKey.map((field) => [
      field,
      identity.value(value, field)
    ])))
  };
}
function assertInPartition(stream, partition, value) {
  for (const [field, expected] of Object.entries(partition)) {
    const actual = value !== null && typeof value === "object" ? Reflect.get(value, field) : void 0;
    if (actual !== expected)
      throw new TypeError(`Stream ${stream.name} record for partition ${JSON.stringify(partition)} carries ${field} ${JSON.stringify(actual)}`);
  }
}
function readPartitionStates(stream, state) {
  const identity = partitionIdentity(stream);
  const envelope = state;
  return new Map((envelope?.partitions ?? []).map((entry) => [
    identity.key(entry.partition),
    entry
  ]));
}

// packages/elt/dist/core/source.js
var StreamStatus = class {
  stream;
  status;
  partition;
  error;
  constructor(stream, status2, partition = null, error = void 0) {
    this.stream = stream;
    this.status = status2;
    this.partition = partition;
    this.error = error;
    Object.freeze(this);
  }
};
var Source = class {
  // How many streams one read reads at once; their messages interleave. A
  // source raising it reads its context from several extracts together.
  concurrency = 1;
  async discover() {
    return this.catalog;
  }
  // Check source-owned metadata without extraction or rediscovery.
  validate(configuration) {
    const stream = this.member(configuration.stream);
    configuration.validate(stream);
    this.validateExtraction(configuration);
    if (stream.partitionKey !== void 0)
      assertPartitions(stream, this.partitions(stream));
  }
  async *watch(options) {
    for (const stream of options.streams)
      this.member(stream);
    yield* this.observe(options);
  }
  // Source-specific selection rules, checked without I/O.
  validateExtraction(_configuration) {
  }
  // The partitions a partitioned stream is read as, derived from configuration
  // without I/O. The list is not part of the identity: adding or removing a
  // partition keeps every other partition's checkpoint.
  partitions(stream) {
    throw new TypeError(`Source must declare partitions for stream ${stream.name}`);
  }
  member(stream) {
    if (this.catalog.get(stream.name) !== stream)
      throw new TypeError(`Stream ${stream.name} is not from this source's discovered catalog`);
    return stream;
  }
  // Must be lazy: the destination prepares its targets before pulling records.
  // Each checkpoint is a commit point. A full refresh carries none, so it
  // loads all or nothing; an incremental read that fails keeps what earlier
  // checkpoints committed. states holds each incremental stream's saved state.
  async *read(catalog, states) {
    var _stack = [];
    try {
      for (const configuration of catalog)
        this.validate(configuration);
      if (new Set(catalog.map(({ stream }) => stream.name)).size !== catalog.length)
        throw new TypeError("A read selects each stream once");
      const context = __using(_stack, await this.open(catalog.map(({ stream }) => stream)), true);
      if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1)
        throw new TypeError("Source concurrency must be a positive integer");
      yield* interleave(catalog.map((configuration) => this.#stream(configuration, states.get(configuration.stream.name) ?? null, context)), this.concurrency);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
  async *#stream(configuration, state, context) {
    const { name } = configuration.stream;
    yield new StreamStatus(name, "STARTED");
    if (configuration.stream.partitionKey !== void 0)
      yield* this.partitioned(configuration, state, context);
    else {
      const incremental = configuration.syncMode === "incremental";
      try {
        for await (const message3 of this.resolved(configuration, this.extract(configuration, state, null, context)))
          if (incremental || !("type" in message3) || message3.type !== "STATE")
            yield message3;
      } catch (error) {
        yield new StreamStatus(name, "FAILED", null, error);
      }
    }
    yield new StreamStatus(name, "ENDED");
  }
  // Keeps each message to the stream whose extract emitted it, and replaces
  // each record's staging path with the file reads it asked for.
  async *resolved(configuration, messages) {
    for await (const message3 of messages) {
      if (message3 instanceof StreamStatus)
        throw new TypeError("Only Source.read reports stream status; extract signals failure by throwing");
      if (message3.stream !== configuration.stream.name)
        throw new TypeError(`Extract for ${configuration.stream.name} emitted ${message3.stream}`);
      if ("type" in message3 || configuration.fileReads.length === 0) {
        yield message3;
        continue;
      }
      if (message3.file !== null && typeof message3.file !== "string")
        throw new TypeError("File extraction must supply a staging path or explicit null");
      const data = message3.data;
      if (data === null || typeof data !== "object" || Array.isArray(data))
        throw new TypeError("File metadata must be an object");
      const output = { ...data };
      const values = /* @__PURE__ */ new Map();
      for (const read of configuration.fileReads) {
        if (Object.keys(data).some((name) => name.toLowerCase() === read.name.toLowerCase()))
          throw new TypeError("File field collides with source metadata");
        let value = null;
        if (message3.file !== null) {
          let pending = values.get(read.parser);
          if (pending === void 0) {
            pending = read.parser === void 0 ? new FileContent(message3.file) : read.parser.parse(message3.file);
            values.set(read.parser, pending);
          }
          value = await pending;
          if (read.parser !== void 0 && value !== null && typeof value !== "string")
            throw new TypeError("Document parser must return text or null");
        }
        Object.defineProperty(output, read.name, { value, enumerable: true });
      }
      yield { stream: message3.stream, data: output };
    }
  }
  // Reads each partition with its own saved state: null for a partition not
  // seen before, so it starts from the source's normal beginning. Every
  // checkpoint carries all listed partitions' latest states, so a partition
  // not yet read, or one that failed, keeps what it had. Partitions no longer
  // listed drop out of the next checkpoint; their rows stay loaded.
  async *partitioned(configuration, state, context) {
    const { stream } = configuration;
    const incremental = configuration.syncMode === "incremental";
    const saved = incremental ? readPartitionStates(stream, state) : /* @__PURE__ */ new Map();
    const identity = partitionIdentity(stream);
    const listed = this.partitions(stream).map((entry) => readPartition(identity, entry));
    const latest = new Map(saved);
    for (const { key, partition } of listed) {
      try {
        for await (const message3 of this.resolved(configuration, this.extract(configuration, saved.get(key)?.state ?? null, partition, context))) {
          if ("type" in message3 && message3.type === "STATE") {
            if (!incremental)
              continue;
            latest.set(key, { partition, state: message3.state });
            yield {
              type: "STATE",
              stream: stream.name,
              state: {
                partitions: listed.flatMap((entry) => latest.get(entry.key) ?? [])
              }
            };
            continue;
          }
          assertInPartition(stream, partition, "type" in message3 ? message3.key : message3.data);
          yield message3;
        }
      } catch (error) {
        yield new StreamStatus(stream.name, "FAILED", partition, error);
        if (!incremental)
          return;
      }
    }
  }
};

// packages/elt/dist/core/replication.js
var Replicated = class {
  stage;
  emitted = { count: 0, deleted: 0 };
  committed = { count: 0, deleted: 0 };
  pending = { count: 0, deleted: 0 };
  failures = [];
  // Nothing commits after a failed read until the next checkpoint: a full
  // refresh has none, so any failure keeps the previous target.
  failed = false;
  // Nothing was applied since the last commit.
  clean = false;
  // The stage failed; the stream's remaining messages are ignored.
  broken = false;
  started = false;
  ended = false;
  resuming = false;
  settled = false;
  copy;
  observe;
  files;
  constructor(copy, source, destination, observe) {
    this.copy = copy;
    this.observe = observe;
    this.files = new FileTransfer(copy.configuration.fileReads, destination.identity(copy.to), copy.writer(source));
  }
  get stream() {
    return this.copy.from;
  }
  outcome() {
    return { copy: this.copy, ...this.committed, failures: this.failures };
  }
  report() {
    if (!this.settled)
      this.#notify("running");
  }
  settle() {
    if (this.settled)
      return;
    this.settled = true;
    this.#notify(this.failures.length === 0 ? "complete" : "incomplete");
  }
  #notify(status2) {
    try {
      this.observe?.({
        copy: this.copy,
        status: status2,
        emitted: { ...this.emitted },
        committed: { ...this.committed }
      });
    } catch {
    }
  }
};
async function replicate(source, destination, checkpoints, copies, observe) {
  const replications = copies.map((copy) => new Replicated(copy, source, destination, observe));
  const bindings = /* @__PURE__ */ new Map();
  for (const { copy } of replications)
    if (copy.configuration.syncMode === "incremental" && copy.id !== void 0)
      bindings.set(copy.id, {
        source: source.identity,
        target: destination.identity(copy.to),
        configuration: copy.configuration
      });
  try {
    if (checkpoints === void 0 || bindings.size === 0)
      await transfer(source, destination, null, replications);
    else
      await checkpoints.run(bindings, (run) => transfer(source, destination, run, replications));
  } catch (error) {
    for (const replication of replications)
      if (!replication.ended)
        fail(replication, error);
  }
  for (const replication of replications)
    replication.settle();
  return replications.map((replication) => replication.outcome());
}
async function transfer(source, destination, run, replications) {
  var _stack = [];
  try {
    const byStream = new Map(replications.map((replication) => [replication.stream.name, replication]));
    const incremental = (replication) => replication.copy.configuration.syncMode === "incremental";
    const checkpoint = (replication) => {
      if (run === null || replication.copy.id === void 0)
        throw new TypeError("Incremental copies require a stable id and checkpoint store");
      return { run, id: replication.copy.id };
    };
    const states = /* @__PURE__ */ new Map();
    const reading = [];
    for (const replication of replications) {
      if (!incremental(replication)) {
        reading.push(replication);
        continue;
      }
      try {
        const { run: run2, id } = checkpoint(replication);
        const state = run2.state(id);
        replication.resuming = state !== null;
        states.set(replication.stream.name, state);
        reading.push(replication);
      } catch (error) {
        fail(replication, error);
      }
    }
    if (reading.length === 0)
      return;
    const load = __using(_stack, await destination.load(), true);
    const prepared = [];
    for (const replication of reading)
      try {
        replication.stage = await load.prepare(replication.copy.configuration, replication.copy.to, {
          writer: replication.copy.writer(source),
          resuming: replication.resuming
        });
        await replication.files.reconcile(replication.stage.values);
        prepared.push(replication);
      } catch (error) {
        if (replication.stage !== void 0)
          await breakStage(replication, error);
        else
          fail(replication, error);
      }
    if (prepared.length === 0)
      return;
    try {
      for await (const message3 of source.read(prepared.map(({ copy }) => copy.configuration), states)) {
        const replication = byStream.get(validStream(message3));
        if (replication === void 0 || !prepared.includes(replication))
          throw new TypeError(`Source emitted an unselected stream: ${message3.stream}`);
        if (replication.ended)
          throw new TypeError(`Source emitted ${message3.stream} after it ended`);
        try {
          if (message3 instanceof StreamStatus) {
            if (message3.status === "STARTED") {
              if (replication.started)
                throw new TypeError(`Source started ${message3.stream} twice`);
              replication.started = true;
              replication.report();
            } else if (message3.status === "FAILED") {
              if (replication.broken)
                continue;
              await started(replication).discard();
              replication.pending.count = 0;
              replication.pending.deleted = 0;
              replication.failed = true;
              replication.failures.push({
                partition: message3.partition,
                error: message3.error
              });
              await replication.files.reconcile(started(replication).values);
              replication.report();
            } else {
              replication.ended = true;
              if (replication.broken) {
                replication.settle();
                continue;
              }
              const stage = started(replication);
              if (!replication.failed && !replication.clean)
                await commit(replication);
              replication.stage = void 0;
              await stage[Symbol.asyncDispose]();
              replication.settle();
            }
            continue;
          }
          if (replication.broken)
            continue;
          const operation = validOperation(replication.stream, message3);
          if (operation.type === "STATE") {
            if (!incremental(replication))
              throw new TypeError(`Full refresh stream ${message3.stream} emitted a checkpoint`);
            await commit(replication);
            const { run: run2, id } = checkpoint(replication);
            await run2.save(id, operation.state);
          } else {
            await started(replication).apply(operation.type === "RECORD" ? {
              ...operation,
              data: await replication.files.record(operation.data)
            } : operation);
            replication.clean = false;
            if (operation.type === "RECORD") {
              replication.pending.count++;
              replication.emitted.count++;
            } else {
              replication.pending.deleted++;
              replication.emitted.deleted++;
            }
            replication.report();
          }
        } catch (error) {
          await breakStage(replication, error);
        }
      }
      for (const replication of prepared)
        if (!replication.ended && !replication.broken)
          await breakStage(replication, new TypeError(`Source did not end stream ${replication.stream.name}`));
    } catch (error) {
      for (const replication of prepared)
        if (!replication.ended && !replication.broken)
          await breakStage(replication, error);
    }
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    var _promise = __callDispose(_stack, _error, _hasError);
    _promise && await _promise;
  }
}
function started(replication) {
  if (!replication.started || replication.stage === void 0)
    throw new TypeError(`Source sent ${replication.stream.name} a message before starting it`);
  return replication.stage;
}
async function commit(replication) {
  await started(replication).commit();
  replication.clean = true;
  replication.failed = false;
  replication.committed.count += replication.pending.count;
  replication.committed.deleted += replication.pending.deleted;
  replication.pending.count = 0;
  replication.pending.deleted = 0;
  await replication.files.reconcile(started(replication).values);
  replication.report();
}
function fail(replication, error) {
  replication.failures.push({ partition: null, error });
  replication.broken = true;
  replication.ended = true;
  replication.settle();
}
async function breakStage(replication, error) {
  replication.failures.push({ partition: null, error });
  replication.broken = true;
  const { stage } = replication;
  replication.stage = void 0;
  try {
    await stage?.[Symbol.asyncDispose]();
  } catch (cause) {
    replication.failures.push({ partition: null, error: cause });
  }
}
function validStream(message3) {
  if (message3 === null || typeof message3 !== "object" || typeof message3.stream !== "string")
    throw new TypeError("Source must emit records with stream and data, DELETE or STATE messages");
  return message3.stream;
}
function validOperation(stream, message3) {
  if ("type" in message3 && message3.type === "STATE" && Object.hasOwn(message3, "state") && !Object.hasOwn(message3, "data")) {
    const state = JSON.parse(JSON.stringify(message3.state));
    if (!isDeepStrictEqual2(state, message3.state))
      throw new TypeError("Checkpoint state must be losslessly JSON serializable");
    wellFormed(state, "Checkpoint state");
    return { type: "STATE", state };
  }
  if ("type" in message3 && message3.type === "DELETE" && Object.hasOwn(message3, "key") && !Object.hasOwn(message3, "data"))
    return { type: "DELETE", key: deletionKey(stream, message3.key) };
  if (!("type" in message3) && "data" in message3 && Object.hasOwn(message3, "data")) {
    if (Object.hasOwn(message3, "file"))
      throw new TypeError("Destinations cannot receive source staging paths");
    wellFormed(message3.data, "Record");
    return { type: "RECORD", data: message3.data };
  }
  throw new TypeError("Source must emit records with stream and data, DELETE or STATE messages");
}
function wellFormed(value, path) {
  if (typeof value === "string") {
    if (!value.isWellFormed())
      throw new TypeError(`${path} has a lone surrogate`);
  } else if (Array.isArray(value))
    for (const [index, item] of value.entries())
      wellFormed(item, `${path}[${index}]`);
  else if (value !== null && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
    for (const [name, item] of Object.entries(value)) {
      if (!name.isWellFormed())
        throw new TypeError(`${path} has a field name with a lone surrogate`);
      wellFormed(item, `${path} field ${name}`);
    }
}
function deletionKey(stream, key) {
  const { name, primaryKey, emitsDeletes } = stream;
  if (!emitsDeletes)
    throw new TypeError(`Stream ${name} does not emit deletions`);
  if (key === null || typeof key !== "object" || Array.isArray(key) || Object.getPrototypeOf(key) !== Object.prototype || Object.keys(key).length !== primaryKey.length || !primaryKey.every((field) => Object.hasOwn(key, field)))
    throw new TypeError(`DELETE for ${name} must carry exactly its primary key ${JSON.stringify(primaryKey)}`);
  const snapshot = {};
  for (const field of primaryKey) {
    const value = Reflect.get(key, field);
    if (!(typeof value === "string" && value.isWellFormed()) && !(typeof value === "number" && Number.isFinite(value)) && typeof value !== "boolean")
      throw new TypeError(`DELETE for ${name} has an invalid ${field}`);
    snapshot[field] = value;
  }
  return Object.freeze(snapshot);
}

// packages/elt/dist/core/writer.js
var TargetOwnedError = class extends TypeError {
  name = "TargetOwnedError";
  constructor(target, owner, writer) {
    super(`Target ${target} is written by ${owner}; ${writer} cannot write it. A target has one writer; clear the owning copy, or drop the target, to reassign it.`);
  }
};
var TargetMissingError = class extends TypeError {
  name = "TargetMissingError";
  constructor(target, writer) {
    super(`Target ${target} was dropped, but ${writer} still has a checkpoint; clear the copy to reload it from scratch.`);
  }
};
var Writer = class {
  stream;
  constructor(stream) {
    this.stream = stream;
  }
};

// packages/elt/dist/core/pipeline.js
var PipelineError = class extends AggregateError {
  name = "PipelineError";
  results;
  constructor(results, unrun) {
    const incomplete = results.filter(({ failures }) => failures.length > 0);
    const errors = [
      ...incomplete.flatMap(({ failures }) => failures.map(({ error }) => error)),
      ...unrun
    ];
    super(errors, [
      ...incomplete.length > 0 ? [
        `The following copies did not load completely: ${incomplete.map(describeFailures).join("; ")}`
      ] : [],
      ...unrun.map(message)
    ].join("; "), { cause: errors[0] });
    this.results = Object.freeze([...results]);
  }
};
var Pipeline = class {
  connections;
  history;
  constructor({ connections, history }) {
    if (!connections.every((connection) => connection instanceof Connection))
      throw new TypeError("Pipeline connections must be Connection declarations");
    this.connections = Object.freeze([...connections]);
    this.history = history;
    Object.freeze(this);
  }
  // Airbyte's Clear for these copies: empties each target and removes its checkpoint.
  async clear(steps = this.connections.flatMap((connection) => connection.steps)) {
    this.#assertDistinct();
    for (const connection of this.connections)
      connection.validate();
    this.#assertOwners();
    for (const copy of steps) {
      const connection = this.connections.find(({ steps: steps2 }) => steps2.includes(copy));
      if (connection === void 0)
        throw new TypeError("Only this pipeline's copies can be cleared");
      await copy.clear(connection.source, connection.destination, connection.checkpoints);
    }
  }
  async run() {
    await this.#declare();
    const passes = await Promise.all(this.connections.map((connection) => this.#pass(connection, connection.steps).then(({ outcomes }) => outcomes, (error) => connectionError(connection, error))));
    const unrun = passes.filter((pass) => pass instanceof Error);
    const results = passes.filter((pass) => !(pass instanceof Error)).flat();
    if (unrun.length > 0 || results.some(({ failures }) => failures.length > 0))
      throw new PipelineError(results, unrun);
    return results.map(({ failures: _, ...result }) => result);
  }
  // Each connection watches its own source and runs a pass for what changed.
  // A connection whose watcher fails stops alone, and its failure is recorded;
  // the rest keep watching. Once every connection stopped, or signal aborts,
  // the failures are thrown together.
  async *watch({ signal }) {
    await this.#declare();
    if (signal.aborted)
      return;
    const controller = new AbortController();
    const watching = AbortSignal.any([signal, controller.signal]);
    const stopped = [];
    const passes = interleave(this.connections.filter(({ steps }) => steps.length > 0).map((connection) => this.#watch(connection, watching, stopped)), Number.POSITIVE_INFINITY);
    try {
      for (let next = await passes.next(); !next.done; next = await passes.next())
        yield next.value;
    } finally {
      controller.abort();
      await passes.return(void 0);
    }
    if (stopped.length > 0)
      throw new AggregateError(stopped, stopped.map(message).join("; "));
  }
  async *#watch(connection, signal, stopped) {
    const controller = new AbortController();
    const watching = AbortSignal.any([signal, controller.signal]);
    const streams = new Map(connection.steps.map((copy) => [copy.from.name, copy.from]));
    const pending = /* @__PURE__ */ new Set();
    let wake = Promise.withResolvers();
    let finished = false;
    let failed = false;
    let failure;
    const receive = (async () => {
      let initial = true;
      try {
        for await (const changed of connection.source.watch({
          streams: [...streams.values()],
          signal: watching
        })) {
          for (const stream of changed) {
            if (!streams.has(stream.name))
              throw new TypeError(`Watcher emitted an unselected stream: ${stream.name}`);
            pending.add(stream.name);
          }
          if (initial && pending.size !== streams.size)
            throw new TypeError("Watcher must initially invalidate every selected stream");
          initial = false;
          if (pending.size > 0)
            wake.resolve();
        }
        if (initial && !watching.aborted)
          throw new TypeError("Watcher ended before its initial invalidation");
      } catch (error) {
        if (!(watching.aborted && error instanceof Error && error.name === "AbortError")) {
          failed = true;
          failure = error;
        }
      } finally {
        finished = true;
        wake.resolve();
      }
    })();
    try {
      while (!watching.aborted) {
        if (failed)
          throw failure;
        if (pending.size === 0) {
          if (finished)
            return;
          await wake.promise;
          continue;
        }
        const steps = connection.steps.filter((copy) => pending.has(copy.from.name));
        pending.clear();
        wake = Promise.withResolvers();
        yield await this.#pass(connection, steps);
      }
      if (failed)
        throw failure;
    } catch (error) {
      stopped.push(connectionError(connection, error));
      await this.#recordFailure(connection, error).catch((cause) => stopped.push(connectionError(connection, cause)));
    } finally {
      controller.abort();
      await receive;
    }
  }
  // One read per pass, never held between watch passes: a long read can
  // block the upstream's own maintenance, such as SQLite WAL checkpoints.
  async #pass(connection, steps) {
    const record = await this.history?.begin(connection, steps.map((copy) => ({
      copy,
      coverage: connection.source.coverage(copy.from)
    })));
    let outcomes;
    try {
      outcomes = await replicate(connection.source, connection.destination, connection.checkpoints, steps, record?.progress?.bind(record));
    } catch (error) {
      await record?.fail(error);
      throw error;
    }
    await record?.finish(outcomes);
    return Object.freeze({ connection, outcomes: Object.freeze(outcomes) });
  }
  async #recordFailure(connection, error) {
    if (this.history === void 0)
      return;
    const record = await this.history.begin(connection, connection.steps.map((copy) => ({
      copy,
      coverage: connection.source.coverage(copy.from)
    })));
    await record.fail(error);
  }
  // Every declaration is checked before any connection reads, so a wiring
  // mistake stops the whole pipeline; the connection it belongs to records it.
  async #declare() {
    this.#assertDistinct();
    for (const connection of this.connections)
      this.history?.validate(connection);
    for (const connection of this.connections)
      try {
        connection.validate();
      } catch (error) {
        await this.#recordFailure(connection, error);
        throw error;
      }
    this.#assertOwners();
  }
  #assertDistinct() {
    const names = this.connections.map(({ name }) => name);
    if (new Set(names).size !== names.length)
      throw new TypeError("Pipeline connection names must be distinct");
    const ids = this.connections.flatMap(({ steps }) => steps.map(({ id }) => id)).filter((id) => id !== void 0);
    if (new Set(ids).size !== ids.length)
      throw new TypeError("Pipeline copy IDs must be distinct");
  }
  // Two copies with different writers into one target fail before any copy
  // runs rather than after the first commits.
  #assertOwners() {
    const owners = /* @__PURE__ */ new Map();
    for (const connection of this.connections)
      for (const copy of connection.steps) {
        const location = connection.destination.location(copy.to);
        const writer = copy.writer(connection.source);
        const owner = owners.get(location);
        if (owner !== void 0 && owner !== writer)
          throw new TargetOwnedError(location, owner, writer);
        owners.set(location, writer);
      }
  }
};
function connectionError(connection, cause) {
  return new Error(`Connection ${connection.name}: ${message(cause)}`, {
    cause
  });
}
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// packages/elt/dist/core/reader-relation.js
var readerCatalog = Object.freeze({
  name: "catalog",
  description: "One row per readable view, table and column, explaining meaning and use. Discover sync_status and extraction_coverage before judging freshness or completeness. Raw tables are not listed.",
  columns: Object.freeze({
    kind: "view, table or column.",
    name: "Relation name, or relation.column.",
    data_type: "Column type; NULL for relations.",
    description: "Meaning, limitations and usage guidance; does not authorize refresh or other writes."
  })
});

// packages/elt/dist/core/record-validation.js
var itemTypes = /* @__PURE__ */ new Set(["string", "integer", "number", "boolean"]);
var scalarTypes = /* @__PURE__ */ new Set([...itemTypes, "null"]);
var typesOf = (field) => typeof field.type === "string" ? [field.type] : field.type;
var isArrayField = (field) => typesOf(field).includes("array");
function supported(field) {
  const types = typesOf(field);
  if (!isArrayField(field))
    return field.items === void 0 && types.every((type) => scalarTypes.has(type));
  const { items } = field;
  return types.every((type) => type === "array" || type === "null") && // Constraints on an array field belong on its items.
  field.enum === void 0 && field.format === void 0 && field.minimum === void 0 && field.maximum === void 0 && field.minLength === void 0 && items !== null && typeof items === "object" && itemTypes.has(items.type);
}
function scalarValid(field, types, value) {
  const typed = types.some((type) => type === "integer" ? Number.isSafeInteger(value) : type === "number" ? typeof value === "number" && Number.isFinite(value) : (type === "string" || type === "boolean") && typeof value === type);
  return typed && (field.enum === void 0 || field.enum.some((member) => member === value)) && !(typeof value === "number" && (field.minimum !== void 0 && value < field.minimum || field.maximum !== void 0 && value > field.maximum)) && !(typeof value === "string" && field.minLength !== void 0 && value.length < field.minLength) && !(field.format === "date-time" && !isTimestamp(value)) && !(field.format === "date" && !isCalendarDate(value));
}
function validateRecords(stream, records, source) {
  if (!Array.isArray(records))
    throw new TypeError(`${source} returned invalid ${stream.name} records`);
  const { properties } = stream.jsonSchema;
  if (properties === void 0)
    throw new TypeError(`Stream ${stream.name} declares no properties to validate`);
  const fields = Object.entries(properties);
  for (const [name, field] of fields)
    if (!supported(field))
      throw new TypeError(`Stream ${stream.name}.${name} declares an unsupported type`);
  const valid = [];
  for (const record of records) {
    assertRecord(record, fields, stream.name, source);
    valid.push(record);
  }
  return valid;
}
function assertRecord(record, fields, stream, source) {
  if (record === null || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== fields.length)
    throw new TypeError(`${source} returned an invalid ${stream} record`);
  for (const [name, field] of fields) {
    const value = Reflect.get(record, name);
    const types = typesOf(field);
    if (value === null && types.includes("null"))
      continue;
    const valid = isArrayField(field) ? Array.isArray(value) && value.every((item) => scalarValid(field.items, [field.items.type], item)) : scalarValid(field, types, value);
    if (!valid)
      throw new TypeError(`${source} returned invalid ${stream}.${name}`);
  }
}

// packages/elt/dist/core/snapshot.js
import { createHash } from "node:crypto";
import { isDeepStrictEqual as isDeepStrictEqual3 } from "node:util";
async function* diffSnapshot(stream, records, state) {
  assertSnapshotStream(stream);
  const deduplication = new Deduplication(stream, stream.primaryKey);
  const previous = readSnapshot(state);
  const current = /* @__PURE__ */ new Map();
  for await (const data of records) {
    const key = deduplication.key(data);
    if (current.has(key))
      throw new TypeError(`Stream ${stream.name} returned key ${key} twice in one scan`);
    const fingerprint = fingerprintOf(stream, data);
    current.set(key, fingerprint);
    if (previous.get(key) !== fingerprint)
      yield { stream: stream.name, data };
  }
  for (const key of previous.keys())
    if (!current.has(key))
      yield {
        type: "DELETE",
        stream: stream.name,
        key: keyObject(stream, key)
      };
  const snapshot = sortedObject(current);
  yield { type: "STATE", stream: stream.name, state: { snapshot } };
}
async function* diffGroupedSnapshot(stream, groups, state) {
  assertSnapshotStream(stream);
  const deduplication = new Deduplication(stream, stream.primaryKey);
  const saved = state;
  const previous = new Map(Object.entries(saved?.groups ?? {}));
  let everyPrevious = null;
  const previousFingerprint = (group, key) => {
    const same = group?.snapshot[key];
    if (same !== void 0)
      return same;
    everyPrevious ??= new Map([...previous.values()].flatMap(({ snapshot }) => Object.entries(snapshot)));
    return everyPrevious.get(key);
  };
  const seen = /* @__PURE__ */ new Set();
  const claim = (key) => {
    if (seen.has(key))
      throw new TypeError(`Stream ${stream.name} returned key ${key} twice in one scan`);
    seen.add(key);
  };
  const current = /* @__PURE__ */ new Map();
  for await (const group of groups) {
    if (current.has(group.key))
      throw new TypeError(`Stream ${stream.name} returned group ${group.key} twice in one scan`);
    const before = previous.get(group.key);
    if (group.fingerprint !== null && before?.fingerprint === group.fingerprint) {
      for (const key of Object.keys(before.snapshot))
        claim(key);
      current.set(group.key, before);
      continue;
    }
    const snapshot = /* @__PURE__ */ new Map();
    for await (const data of group.records()) {
      const key = deduplication.key(data);
      claim(key);
      const fingerprint = fingerprintOf(stream, data);
      snapshot.set(key, fingerprint);
      if (previousFingerprint(before, key) !== fingerprint)
        yield { stream: stream.name, data };
    }
    current.set(group.key, {
      fingerprint: group.fingerprint,
      snapshot: sortedObject(snapshot)
    });
  }
  for (const { snapshot } of previous.values())
    for (const key of Object.keys(snapshot))
      if (!seen.has(key))
        yield {
          type: "DELETE",
          stream: stream.name,
          key: keyObject(stream, key)
        };
  yield {
    type: "STATE",
    stream: stream.name,
    state: { groups: sortedObject(current) }
  };
}
function assertSnapshotStream(stream) {
  if (!stream.sourceDefinedCursor || !stream.emitsDeletes)
    throw new TypeError(`Stream ${stream.name} must declare sourceDefinedCursor and emitsDeletes to diff snapshots`);
}
function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function readSnapshot(state) {
  const saved = state;
  return new Map(Object.entries(saved?.snapshot ?? {}));
}
function keyObject(stream, key) {
  const values = JSON.parse(key);
  return Object.fromEntries(stream.primaryKey.map((field, index) => {
    const value = values[index];
    if (value === void 0)
      throw new TypeError(`Snapshot key ${key} does not match ${stream.name}'s primary key`);
    return [field, value];
  }));
}
function fingerprintOf(stream, record) {
  const serialized = JSON.parse(JSON.stringify(record));
  if (!isDeepStrictEqual3(serialized, record))
    throw new TypeError(`Stream ${stream.name} records must be losslessly JSON serializable to diff snapshots`);
  return createHash("sha256").update(canonical(serialized)).digest("base64url");
}
function canonical(value) {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(",")}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

// packages/elt/dist/core/target-description.js
function annotation(value) {
  if (value === void 0)
    return null;
  if (typeof value !== "string" || value.includes("\0") || !value.isWellFormed())
    throw new TypeError("JSON Schema description must be well-formed text without NUL");
  return value;
}
var loading = {
  append: "Every accepted observation is appended; source keys may repeat.",
  overwrite: "Each full refresh replaces the table with its accepted records.",
  append_dedup: "Accepted observations reconcile rows by the copy key.",
  overwrite_dedup: "Each full refresh replaces the table with deduplicated records."
};
function describeTarget(configuration, columns, storedFile) {
  const { stream } = configuration;
  const meaning = annotation(stream.jsonSchema.description);
  const lines = [`Source stream: ${stream.name}.`];
  if (meaning !== null)
    lines.push(`Source record meaning: ${meaning}`);
  lines.push(`Extraction: ${configuration.syncMode}. Loading: ${configuration.destinationSyncMode}. ${loading[configuration.destinationSyncMode]}`);
  if (configuration.dedupPolicy !== void 0) {
    const { primaryKey, cursorField } = configuration.deduplication();
    lines.push(`Copy key: ${primaryKey.join(", ")}.`);
    lines.push(configuration.dedupPolicy === "replace" ? "For a repeated key, the newest extracted record wins." : `For a repeated key, the greatest ${cursorField} wins; equal cursors retain the first accepted record. Text cursors compare by byte order.`);
  }
  const { properties } = stream.jsonSchema;
  const described = Object.fromEntries(columns.map((column) => {
    if (column.storesFile)
      return [column.name, storedFile(column)];
    if (column.fileRead?.parser !== void 0)
      return [
        column.name,
        `Text extracted from the source file by parser ${column.fileRead.parser.identity}. NULL when the source file is unavailable or the parser returns no text.`
      ];
    if (column.fileRead?.file.storage !== void 0)
      return [
        column.name,
        `${column.fileRead.file.storage.reference} NULL when the source file is unavailable.`
      ];
    return [column.name, annotation(properties?.[column.name]?.description)];
  }));
  described.loaded_at = "Start time of the load that last wrote this row, not the source modification time or the most recent successful sync.";
  return Object.freeze({
    meaning,
    table: lines.join("\n"),
    columns: Object.freeze(described)
  });
}
function undescribed({ meaning, columns }) {
  const missing = Object.entries(columns).flatMap(([column, text2]) => text2 === null ? [column] : []);
  if (meaning === null)
    missing.unshift("the stream");
  return missing;
}

// packages/elt/dist/state/checkpoint-store.js
import { isDeepStrictEqual as isDeepStrictEqual4 } from "node:util";
var CheckpointStore = class {
  // Holds every replication's lock for the whole run.
  async run(bindings, work) {
    const ids = [...bindings.keys()].sort();
    return this.session(ids, async (session) => {
      const checkpoints = /* @__PURE__ */ new Map();
      for (const id of ids) {
        const binding = JSON.stringify(bindings.get(id));
        const saved = await session.read(id);
        const changed = saved !== void 0 && !isDeepStrictEqual4(JSON.parse(saved.binding), JSON.parse(binding));
        checkpoints.set(id, {
          binding,
          state: saved === void 0 || changed ? null : JSON.parse(saved.state),
          changed
        });
      }
      const checkpoint = (id) => {
        const found = checkpoints.get(id);
        if (found === void 0)
          throw new TypeError(`Checkpoint ${id} is not part of this run`);
        if (found.changed)
          throw new TypeError(`Checkpoint binding changed for ${id}; reset it or use a new copy ID`);
        return found;
      };
      return work({
        // A source may mutate its input state, but only an acknowledged message may advance it.
        state: (id) => structuredClone(checkpoint(id).state),
        save: async (id, state) => {
          const { binding } = checkpoint(id);
          try {
            await session.save(id, { binding, state: JSON.stringify(state) });
          } catch (cause) {
            throw new Error(`Checkpoint ${id} was not saved after the destination committed; the next run replays from the last saved checkpoint`, { cause });
          }
        }
      });
    });
  }
  // Forgets progress but keeps the loaded rows: the next run reloads
  // everything, as Airbyte's refresh that keeps records.
  async reset(id) {
    await this.session([id], (session) => session.remove(id));
  }
  // Airbyte's Clear: removes the data, then the checkpoint, under the
  // replication's lock. A crash between the two leaves a checkpoint beside an
  // emptied target, and clear can simply run again.
  async clear(id, drop) {
    await this.session([id], async (session) => {
      await drop();
      await session.remove(id);
    });
  }
};

// packages/elt/dist/state/sync-history.js
var SyncHistory = class {
  // Refuses, without I/O, a connection this history cannot record.
  validate(_connection) {
  }
};
function copyStatus({ count, deleted, failures }) {
  if (failures.length === 0)
    return "succeeded";
  return count + deleted > 0 ? "partial" : "failed";
}
function passStatus(outcomes) {
  if (outcomes.every(({ failures }) => failures.length === 0))
    return "succeeded";
  return outcomes.some((outcome) => copyStatus(outcome) !== "failed") ? "partial" : "failed";
}
function passError(outcomes) {
  const incomplete = outcomes.filter(({ failures }) => failures.length > 0);
  if (incomplete.length === 0)
    return null;
  return `The following copies did not load completely: ${incomplete.map(describeFailures).join("; ")}`;
}

// packages/elt/dist/state/sync-history-relations.js
var attempt = {
  attempt_id: "Pass identifier. Join to extraction_coverage.attempt_id for the exact declarations and copy outcomes of this pass.",
  connector: "Connection name declared by the application. Each attempt is one pass: one read of the streams the connection selected.",
  source: "Source identity, not credentials or a record identifier.",
  started_at: "Database time when the attempt and its declared coverage were recorded, before the pass read anything. Not a source record modification or row load time.",
  completed_at: "Database time when the pass outcomes were recorded. NULL means no completion was recorded; this is not evidence that a process is alive.",
  status: "running: no completion recorded; succeeded: all selected copies completed, including empty or unchanged reads; partial: failures with some successful copies or committed writes/deletes; failed: failures without that progress. No watcher health is implied.",
  error: "Pipeline error message, or NULL after success or before completion. Per-copy failures and partitions are in extraction_coverage."
};
var syncHistoryRelations = {
  sync_attempts: {
    name: "sync_attempts",
    description: "One row per pass of a connection. A run passes every stream the connection selected; a watch pass reads only the streams its source reported changed, so an attempt vouches only for its own extraction_coverage rows. History is retained, including failures and unfinished attempts. A successful pass may write zero rows. A connection whose watcher stopped records a failed attempt without outcomes. Setup/authentication before the pipeline is constructed is not observed. This records extraction/load outcomes, not subsequent mart publication.",
    columns: attempt
  },
  extraction_coverage: {
    name: "extraction_coverage",
    description: "One row per selected stream per attempt, declared before extraction even when there are no records. Description and selection describe the requested export scope, not observed record dates or proof of upstream completeness. Only succeeded confirms that this copy completed that declared pass; partial/failed/running never establish complete coverage. Earlier successful declarations remain available. Raw target names identify storage, not reader grants; discover readable content in catalog.",
    columns: {
      attempt_id: attempt.attempt_id,
      connector: attempt.connector,
      source: attempt.source,
      started_at: attempt.started_at,
      completed_at: "Time the whole attempt was recorded as complete; NULL while unfinished. The copy may have finished earlier. Not record modification time or loaded_at.",
      stream: "Source stream name, unique within one attempt.",
      target_schema: "Schema of the raw destination table (main in SQLite); this metadata does not grant access to it.",
      target_table: "Raw destination table name within target_schema.",
      target_exists: "Whether the raw relation exists now, independent of this historical attempt. Existence does not prove successful extraction, current contents, or reader access.",
      sync_mode: "Requested source mode: incremental or full_refresh. Incremental copies can resume saved state; the selection describes their configured scope, not every request made on this pass.",
      destination_sync_mode: "Requested load mode, such as append_dedup. Partial passes can leave previously committed changes in the destination.",
      description: "Connector-owned explanation of the scope, date boundaries, selection keys and source limitations for this stream.",
      selection: "Structured configured selection, interpreted using description. Not computed from rows. Empty object means no additional configured selection, not unlimited upstream history.",
      status: "running: no outcome recorded; succeeded: copy completed with no failures, even with zero changes; partial: failures after committed writes/deletes; failed: failures without committed row changes, or an error without outcomes. Consult failures for affected partitions.",
      written_count: "Accepted record operations committed by this copy during this pass, including deduplication no-ops. Not changed-row or total-record counts. Zero is valid after success. NULL means no counts were reported.",
      deleted_count: "Accepted deletion operations committed by this copy during this pass, including already-absent keys. Not a count of rows actually removed. NULL means no counts were reported.",
      failures: "Array of {partition, error} from pass outcomes. A null partition denotes a whole-stream or non-partition-specific failure. Empty array means none recorded; check status before assuming success."
    }
  },
  sync_status: {
    name: "sync_status",
    description: "One row per connector with its latest started attempt and independently its most recently completed successful pass. A watch pass covers only the streams that changed; see stream_status for each stream. A later failed, partial or unfinished pass does not erase prior success. Join extraction_coverage using the appropriate attempt ID: requested scope can change. NULL success means none recorded. These timestamps measure sync completion, not service liveness or source completeness.",
    columns: {
      connector: attempt.connector,
      latest_attempt_id: "Most recently started attempt for this connector; join sync_attempts or extraction_coverage by attempt_id.",
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      status: attempt.status,
      error: attempt.error,
      last_successful_attempt_id: "Most recently completed all-copies-successful attempt; NULL if none. Its coverage may differ from the latest attempt.",
      last_successful_sync_at: "Completion time of that successful pass, advanced even if no rows changed. NULL if no successful pass was recorded. Never inferred from loaded_at or record modification dates."
    }
  },
  stream_status: {
    name: "stream_status",
    description: "One row per connector and stream: the latest attempt that declared the stream, and independently the last attempt in which its copy succeeded. A watch pass reads only the streams its source reported changed, so a connector can succeed in sync_status while one of its streams last failed; judge a stream here. NULL success means that stream never completed.",
    columns: {
      connector: attempt.connector,
      stream: "Source stream name.",
      target_schema: "Schema of the raw destination table in the latest declaration (main in SQLite); this metadata does not grant access to it.",
      target_table: "Raw destination table name within target_schema.",
      latest_attempt_id: "Most recently started attempt that declared this stream; join extraction_coverage by attempt_id and stream.",
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      status: "This stream's copy status in the latest attempt: running, succeeded, partial or failed. Other streams of the same attempt may differ.",
      last_successful_attempt_id: "Most recent completed attempt in which this stream's copy succeeded; NULL if none.",
      last_successful_sync_at: "Completion time of that attempt, advanced even if no rows changed. NULL if this stream never succeeded. Never inferred from loaded_at or record modification dates."
    }
  }
};

// packages/elt/dist/storage/local-files.js
import { createHash as createHash2, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open as open2, readdir, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
async function syncDirectory(path) {
  var _stack = [];
  try {
    const directory = __using(_stack, await open2(path, "r"), true);
    await directory.sync();
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    var _promise = __callDispose(_stack, _error, _hasError);
    _promise && await _promise;
  }
}
var LocalFiles = class extends FileStorage {
  directory;
  identity;
  reference = "Absolute path, on the machine that ran the load, of a copy of the source file bytes. Named by content hash, keeping a short source extension, and kept only while a row references it. Not the source file name, a URL or extracted text.";
  constructor({ directory }) {
    super();
    if (typeof directory !== "string" || directory.length === 0 || directory.includes("\0") || !directory.isWellFormed())
      throw new TypeError("LocalFiles requires a directory");
    this.directory = resolve(directory);
    this.identity = JSON.stringify({
      type: "local-files",
      directory: this.directory
    });
    Object.freeze(this);
  }
  scopePath(scope) {
    return join(this.directory, ".elt-files", createHash2("sha256").update(scope).digest("hex"));
  }
  async inspect(path) {
    const info = await lstat(path).catch((error) => {
      if (error.code !== "ENOENT")
        throw error;
      return void 0;
    });
    if (info === void 0)
      return false;
    if (!info.isDirectory())
      throw new TypeError(`Managed attachment directories must be real directories: ${path}`);
    return true;
  }
  async save(scope, content) {
    const directory = this.scopePath(scope);
    const created = await mkdir(directory, { recursive: true });
    for (const path of [this.directory, dirname(directory), directory])
      await this.inspect(path);
    if (created !== void 0) {
      let path = directory;
      while (path !== dirname(created)) {
        await syncDirectory(path);
        path = dirname(path);
      }
      await syncDirectory(path);
    }
    const temporary = join(directory, `.pending-${randomUUID()}`);
    try {
      const hash = createHash2("sha256");
      {
        var _stack = [];
        try {
          const file = __using(_stack, await open2(temporary, "wx", 384), true);
          for await (const chunk of content.chunks(4 * 1024 * 1024)) {
            hash.update(chunk);
            await file.writeFile(chunk);
          }
          await file.sync();
        } catch (_) {
          var _error = _, _hasError = true;
        } finally {
          var _promise = __callDispose(_stack, _error, _hasError);
          _promise && await _promise;
        }
      }
      const extension = extname(content.path);
      const path = join(directory, hash.digest("hex") + (/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : ""));
      await link(temporary, path).catch(async (error) => {
        if (error.code !== "EEXIST")
          throw error;
        if (!(await lstat(path)).isFile())
          throw new TypeError(`Attachment reference is not a regular file: ${path}`);
      });
      await syncDirectory(directory);
      return path;
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async retain(scope, references) {
    const directory = this.scopePath(scope);
    for (const path of [this.directory, dirname(directory), directory]) {
      if (await this.inspect(path))
        continue;
      if (references.size > 0)
        throw new Error(`Stored attachment directory is missing: ${directory}`);
      return;
    }
    const missing = new Set(references);
    const obsolete = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (references.has(path)) {
        if (!entry.isFile())
          throw new TypeError(`Attachment reference is not a regular file: ${path}`);
        missing.delete(path);
        continue;
      }
      if (/^(?:[a-f0-9]{64}(?:\.[a-zA-Z0-9]{1,16})?|\.pending-[a-f0-9-]+)$/.test(entry.name)) {
        if (!entry.isFile())
          throw new TypeError(`Managed attachment is not a regular file: ${path}`);
        obsolete.push(path);
      }
    }
    if (missing.size > 0)
      throw new Error(`Stored attachment is missing or outside its scope: ${[...missing][0]}`);
    for (const path of obsolete)
      await rm(path);
    await syncDirectory(directory);
  }
};

// packages/destinations/sqlite/dist/sqlite-catalog.js
import { DatabaseSync } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-descriptions.js
var descriptions = '"_elt_descriptions"';
function createDescriptions(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS ${descriptions} ("relation" TEXT NOT NULL COLLATE NOCASE, "column" TEXT NOT NULL COLLATE NOCASE, "data_type" TEXT, "description" TEXT NOT NULL, PRIMARY KEY ("relation", "column")) STRICT`);
}
function describe(database, relation, description, columns) {
  createDescriptions(database);
  database.exec(`DELETE FROM ${descriptions} WHERE "relation" NOT IN (SELECT "name" FROM sqlite_schema)`);
  database.prepare(`DELETE FROM ${descriptions} WHERE "relation" = ?`).run(relation);
  const declared = new Map(database.prepare('SELECT "name", "type" FROM pragma_table_info(?)').all(relation).map(({ name, type }) => [
    String(name).toLowerCase(),
    String(type).toLowerCase() || null
  ]));
  const insert = database.prepare(`INSERT INTO ${descriptions} ("relation", "column", "data_type", "description") VALUES (?, ?, ?, ?)`);
  insert.run(relation, "", null, description);
  for (const [column, { description: description2, dataType }] of Object.entries(columns))
    if (description2 !== null)
      insert.run(relation, column, dataType ?? declared.get(column.toLowerCase()) ?? null, description2);
}

// packages/destinations/sqlite/dist/sqlite-views.js
var quote = (name) => `"${name.replaceAll('"', '""')}"`;
function text(value, what) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !value.isWellFormed())
    throw new TypeError(`Invalid ${what}`);
}
function publishSQLiteViews(database, { views }) {
  const names = /* @__PURE__ */ new Set();
  for (const view of views) {
    text(view.name, "view name");
    if (/^_elt_/i.test(view.name))
      throw new TypeError("View names starting with _elt_ are reserved");
    if (names.has(view.name.toLowerCase()))
      throw new TypeError("Duplicate view names");
    names.add(view.name.toLowerCase());
    text(view.query, "view query");
    text(view.description, "view description");
    for (const [column, description] of Object.entries(view.columns)) {
      text(column, "column name");
      text(description, "column description");
    }
  }
  if (views.length === 0)
    return;
  database.exec("SAVEPOINT publish");
  try {
    for (const view of views.toReversed())
      database.exec(`DROP VIEW IF EXISTS ${quote(view.name)}`);
    for (const view of views) {
      database.prepare(`CREATE VIEW ${quote(view.name)} AS ${view.query}`).run();
      const columns = database.prepare('SELECT "name" FROM pragma_table_info(?)').all(view.name).map(({ name }) => String(name));
      if (columns.length !== Object.keys(view.columns).length || columns.some((name) => !Object.hasOwn(view.columns, name)))
        throw new TypeError(`View ${quote(view.name)} must describe exactly its output columns: ${columns.join(", ")}`);
      describe(database, view.name, view.description, Object.fromEntries(Object.entries(view.columns).map(([column, description]) => [
        column,
        { description }
      ])));
    }
    database.exec("RELEASE publish");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK TO publish");
      database.exec("RELEASE publish");
    }
    throw error;
  }
}

// packages/destinations/sqlite/dist/sqlite-catalog.js
function installSQLiteCatalog({ path }) {
  var _stack = [];
  try {
    if (path === ":memory:")
      throw new TypeError("A SQLite catalog requires a database file");
    const database = __using(_stack, new DatabaseSync(path, { timeout: 3e4 }));
    database.exec("BEGIN IMMEDIATE");
    try {
      createDescriptions(database);
      publishSQLiteViews(database, {
        views: [
          {
            ...readerCatalog,
            query: `SELECT 'view' AS "kind", s."name" AS "name", NULL AS "data_type", d."description" AS "description"
            FROM sqlite_schema s JOIN ${descriptions} d ON d."relation" = s."name" AND d."column" = ''
            WHERE s."type" = 'view'
            UNION ALL
            SELECT 'column', s."name" || '.' || c."column", c."data_type", c."description"
            FROM sqlite_schema s JOIN ${descriptions} d ON d."relation" = s."name" AND d."column" = ''
            JOIN ${descriptions} c ON c."relation" = s."name" AND c."column" <> ''
            WHERE s."type" = 'view'
            ORDER BY 2`
          }
        ]
      });
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction)
        database.exec("ROLLBACK");
      throw error;
    }
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}

// packages/destinations/sqlite/dist/sqlite-checkpoint-store.js
import { chmodSync } from "node:fs";
import { resolve as resolve2 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var SQLiteCheckpointStore = class extends CheckpointStore {
  path;
  constructor({ path }) {
    super();
    if (!path || path === ":memory:" || path.includes("\0"))
      throw new TypeError("Checkpoints require a persistent SQLite file");
    this.path = resolve2(path);
    Object.freeze(this);
  }
  async session(_ids, work) {
    var _stack = [];
    try {
      const database = __using(_stack, this.open());
      database.exec("BEGIN IMMEDIATE");
      const durable = (statement, ...values) => {
        database.prepare(statement).run(...values);
        database.exec("COMMIT");
        database.exec("BEGIN IMMEDIATE");
      };
      try {
        const result = await work({
          read: async (id) => {
            const saved = database.prepare("SELECT binding, state FROM checkpoints WHERE id = ?").get(id);
            return saved === void 0 ? void 0 : { binding: String(saved.binding), state: String(saved.state) };
          },
          save: async (id, { binding, state }) => durable("INSERT INTO checkpoints (id, binding, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state", id, binding, state),
          remove: async (id) => durable("DELETE FROM checkpoints WHERE id = ?", id)
        });
        database.exec("COMMIT");
        return result;
      } catch (error) {
        if (database.isTransaction)
          database.exec("ROLLBACK");
        throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  open() {
    const database = new DatabaseSync2(this.path);
    try {
      chmodSync(this.path, 384);
      database.exec("CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL) STRICT");
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
};

// packages/destinations/sqlite/dist/sqlite-column.js
var storageTypes = {
  text: "TEXT",
  integer: "INTEGER",
  real: "REAL",
  blob: "BLOB",
  boolean: "INTEGER",
  date: "TEXT",
  timestamp: "TEXT"
};
function canonical2(kind, name) {
  switch (kind) {
    case "boolean":
      return ` CHECK (${name} IN (0, 1))`;
    case "date":
      return ` CHECK (date(${name}) IS ${name})`;
    case "timestamp":
      return ` CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ${name}) IS ${name})`;
    default:
      return "";
  }
}
var SQLiteColumn = class _SQLiteColumn {
  name;
  kind;
  required;
  isPrimaryKey;
  nullable;
  optional;
  // An array of kind, stored as a JSON array in TEXT.
  array;
  fileRead;
  constructor(name, kind, options) {
    if (!name || name.includes("\0"))
      throw new TypeError("Invalid column name");
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError("Unsupported SQLite column type");
    this.array = options.array ?? false;
    if (this.array && (kind === "blob" || options.primaryKey))
      throw new TypeError("Array columns hold scalar values and cannot be keys");
    this.fileRead = options.fileRead;
    if (this.fileRead !== void 0 && (!(this.fileRead instanceof FileRead) || this.fileRead.name !== name))
      throw new TypeError("Column file read must match its name");
    this.name = name;
    this.kind = kind;
    this.isPrimaryKey = options.primaryKey;
    this.nullable = !options.primaryKey && options.nullable;
    this.optional = !options.primaryKey && options.optional;
    this.required = !this.nullable && !this.optional;
    Object.freeze(this);
  }
  primaryKey() {
    return new _SQLiteColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: true,
      array: this.array,
      fileRead: this.fileRead
    });
  }
  notNull() {
    return new _SQLiteColumn(this.name, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead
    });
  }
  from(file) {
    if (this.array || this.kind !== "blob" && this.kind !== "text")
      throw new TypeError("Files require a BLOB column, parsed TEXT or a stored TEXT reference");
    return new _SQLiteColumn(this.name, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.name, file, this.fileRead?.parser)
    });
  }
  parse(parser) {
    if (this.kind !== "text")
      throw new TypeError("Document parsing requires a TEXT column");
    if (this.fileRead === void 0)
      throw new TypeError("Select a source file before selecting a parser");
    return new _SQLiteColumn(this.name, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.name, this.fileRead.file, parser)
    });
  }
  get quotedName() {
    return `"${this.name.replaceAll('"', '""')}"`;
  }
  // Original file bytes live in a chunk table; the column keeps the file's id.
  get storesFile() {
    return this.kind === "blob" && this.fileRead !== void 0;
  }
  get storageType() {
    if (this.array)
      return "TEXT";
    return this.storesFile ? "INTEGER" : storageTypes[this.kind];
  }
  // The column's type as readers see it in the catalog.
  get dataType() {
    if (this.storesFile)
      return "integer";
    return this.array ? `${this.kind}[]` : this.kind;
  }
  get definition() {
    const check = this.array ? ` CHECK (json_valid(${this.quotedName}) AND json_type(${this.quotedName}) = 'array')` : canonical2(this.kind, this.quotedName);
    return `${this.quotedName} ${this.storageType}${this.isPrimaryKey ? " PRIMARY KEY" : ""}${this.required ? " NOT NULL" : ""}${check}`;
  }
  encode(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record))
      throw new TypeError(`Record is missing column "${this.name}"`);
    if (!Object.hasOwn(record, this.name)) {
      if (this.optional)
        return null;
      throw new TypeError(`Record is missing column "${this.name}"`);
    }
    const value = Reflect.get(record, this.name);
    if (value === null && this.nullable)
      return null;
    if (this.array) {
      if (Array.isArray(value) && value.every((element) => this.#element(element)))
        return JSON.stringify(value);
      throw new TypeError(`Column "${this.name}" requires an array of ${this.kind}${this.nullable ? " or null" : " (not null)"}`);
    }
    switch (this.kind) {
      case "text":
        if (typeof value === "string")
          return value;
        break;
      case "boolean":
        if (typeof value === "boolean")
          return Number(value);
        break;
      case "integer":
        if (typeof value === "bigint" && value >= -(2n ** 63n) && value < 2n ** 63n || typeof value === "number" && Number.isSafeInteger(value))
          return value;
        break;
      case "date":
        if (isCalendarDate(value))
          return value;
        break;
      case "timestamp":
        if (isTimestamp(value))
          return value;
        break;
      case "real":
        if (typeof value === "number" && Number.isFinite(value))
          return value;
        break;
      case "blob":
        if (this.storesFile) {
          if (typeof value === "number" && Number.isSafeInteger(value))
            return value;
        } else if (value instanceof Uint8Array)
          return value;
    }
    throw new TypeError(`Column "${this.name}" requires ${this.kind}${this.nullable ? " or null" : " (not null)"}`);
  }
  // Whether a JSON array element keeps this kind's value exactly.
  #element(value) {
    switch (this.kind) {
      case "text":
        return typeof value === "string";
      case "boolean":
        return typeof value === "boolean";
      case "integer":
        return Number.isSafeInteger(value);
      case "real":
        return typeof value === "number" && Number.isFinite(value);
      case "date":
        return isCalendarDate(value);
      case "timestamp":
        return isTimestamp(value);
      default:
        return false;
    }
  }
};

// packages/destinations/sqlite/dist/sqlite-columns.js
function scalarKind(name, type, format) {
  switch (type) {
    case "string":
      return format === "date" ? "date" : format === "date-time" ? "timestamp" : "text";
    case "integer":
      return "integer";
    case "number":
      return "real";
    case "boolean":
      return "boolean";
    default:
      throw new TypeError(`Unsupported JSON Schema type for field ${name}: ${type}`);
  }
}
var SQLiteColumns = class {
  // Scalars, and arrays of scalars as JSON arrays in TEXT. The date and
  // date-time string formats keep their kind, as in Postgres.
  static fromSchema({ properties, required = [] }) {
    if (properties === void 0)
      throw new TypeError("SQLite requires an object schema with explicit properties");
    const requiredFields = new Set(required);
    for (const name of requiredFields)
      if (!Object.hasOwn(properties, name))
        throw new TypeError(`Schema does not describe field ${name}`);
    return Object.entries(properties).map(([name, field]) => {
      const types = typeof field.type === "string" ? [field.type] : field.type;
      if (new Set(types).size !== types.length)
        throw new TypeError(`Unsupported JSON Schema type for field ${name}`);
      const valueTypes = types.filter((type) => type !== "null");
      const valueType = valueTypes[0];
      if (valueType === void 0 || valueTypes.length !== 1)
        throw new TypeError(`SQLite requires one scalar type for field ${name}`);
      const array = valueType === "array";
      const scalar = array ? field.items : { type: valueType, format: field.format };
      if (scalar === void 0)
        throw new TypeError(`Unsupported JSON Schema items for field ${name}`);
      return new SQLiteColumn(name, scalarKind(name, scalar.type, scalar.format), {
        nullable: types.includes("null"),
        optional: !requiredFields.has(name),
        primaryKey: false,
        array
      });
    });
  }
  text(field) {
    return new SQLiteColumn(field, "text", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
  integer(field) {
    return new SQLiteColumn(field, "integer", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
  real(field) {
    return new SQLiteColumn(field, "real", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
  date(field) {
    return new SQLiteColumn(field, "date", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
  timestamp(field) {
    return new SQLiteColumn(field, "timestamp", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
  blob(field) {
    return new SQLiteColumn(field, "blob", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
  boolean(field) {
    return new SQLiteColumn(field, "boolean", {
      nullable: true,
      optional: false,
      primaryKey: false
    });
  }
};

// packages/destinations/sqlite/dist/sqlite-destination.js
import { resolve as resolve3 } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-writer.js
import { createHash as createHash3 } from "node:crypto";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-file-store.js
var quote2 = (name) => `"${name.replaceAll('"', '""')}"`;
var SQLiteFileStore = class _SQLiteFileStore {
  static chunkSize = 4 * 1024 * 1024;
  name;
  #next;
  #insert;
  constructor(database, table, column) {
    this.name = _SQLiteFileStore.tableName(table, column);
    const chunks = quote2(this.name);
    database.exec(`CREATE TABLE IF NOT EXISTS ${chunks} ("file" INTEGER NOT NULL, "n" INTEGER NOT NULL, "bytes" BLOB NOT NULL, PRIMARY KEY ("file", "n")) STRICT`);
    database.exec(`CREATE TRIGGER IF NOT EXISTS ${quote2(`${this.name}_delete`)} AFTER DELETE ON ${table.quotedName} BEGIN DELETE FROM ${chunks} WHERE "file" = old.${column.quotedName}; END`);
    database.exec(`CREATE TRIGGER IF NOT EXISTS ${quote2(`${this.name}_update`)} AFTER UPDATE OF ${column.quotedName} ON ${table.quotedName} WHEN old.${column.quotedName} IS NOT new.${column.quotedName} BEGIN DELETE FROM ${chunks} WHERE "file" = old.${column.quotedName}; END`);
    this.#next = database.prepare(`SELECT coalesce(max("file"), 0) + 1 AS "file" FROM ${chunks}`);
    this.#insert = database.prepare(`INSERT INTO ${chunks} ("file", "n", "bytes") VALUES (?, ?, ?)`);
  }
  static tableName(table, column) {
    return `_elt_files_${table.location}_${column.name.toLowerCase()}`;
  }
  // An empty file still stores one empty chunk, so its id stays reserved.
  async save(content) {
    const file = Number(this.#next.get()?.file);
    let n = 0;
    for await (const chunk of content.chunks(_SQLiteFileStore.chunkSize))
      this.#insert.run(file, n++, chunk);
    if (n === 0)
      this.#insert.run(file, 0, new Uint8Array());
    return file;
  }
};

// packages/destinations/sqlite/dist/sqlite-writer.js
function lockWriter(path) {
  const lock = new DatabaseSync3(path === ":memory:" ? path : `${path}.writer-lock`);
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return { [Symbol.dispose]: () => lock.close() };
  } catch (error) {
    lock.close();
    throw error;
  }
}
var quote3 = (name) => `"${name.replaceAll('"', '""')}"`;
var seq = '"_elt_seq"';
var op = '"_elt_op"';
var SQLiteWriter = class extends Writer {
  configuration;
  path;
  table;
  #description;
  constructor(configuration, path, table) {
    super(configuration.stream);
    this.configuration = configuration;
    this.path = path;
    this.table = table;
    this.#description = describeTarget(configuration, table.columns, (column) => `Integer reference to the source file's original bytes. Join ${quote3(SQLiteFileStore.tableName(table, column))} on file = this value and concatenate bytes in order of n. NULL when the source file is unavailable.`);
    if (table.readerView === void 0)
      return;
    const missing = undescribed(this.#description);
    if (missing.length > 0)
      throw new TypeError(`Reader view ${table.readerView} needs JSON Schema descriptions for ${missing.join(", ")} of stream ${this.stream.name}`);
  }
  // Inserts each staged record, in order.
  append(database, stage, loadedAt) {
    database.prepare(`INSERT INTO ${this.table.quotedName} (${this.fields.join(", ")}) SELECT ${this.table.columns.map((column) => column.quotedName).join(", ")}, ? FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`).run(loadedAt);
  }
  // An overwrite replaces the target at its first commit.
  get replaces() {
    return false;
  }
  // Empties the target a replacing commit is about to fill.
  replace(database) {
    database.exec(`DELETE FROM ${this.table.quotedName}`);
  }
  get hash() {
    return createHash3("sha256").update(this.table.location).digest("hex");
  }
  get dedupIndex() {
    return quote3(`_elt_dedup_${this.hash}`);
  }
  get fields() {
    return [
      ...this.table.columns.map((column) => column.quotedName),
      '"loaded_at"'
    ];
  }
  encode(record) {
    return this.table.columns.map((column) => column.encode(record));
  }
  // Only a load that identifies rows by key can remove one.
  deletionKeys(_key) {
    throw new TypeError("Only deduplicating loads can apply deletions");
  }
  // The owner lives beside the table it guards and commits with the load. A
  // dropped table releases it, since nothing it held remains.
  writers(database) {
    database.exec('CREATE TABLE IF NOT EXISTS "_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT');
  }
  own(database, writer) {
    this.writers(database);
    database.exec(`DELETE FROM "_elt_writers" WHERE "target" NOT IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`);
    const owner = database.prepare('SELECT "writer" FROM "_elt_writers" WHERE "target" = ?').get(this.table.location)?.writer;
    if (owner === void 0)
      database.prepare('INSERT INTO "_elt_writers" ("target", "writer") VALUES (?, ?)').run(this.table.location, writer);
    else if (owner !== writer)
      throw new TargetOwnedError(this.table.name, String(owner), writer);
  }
  exists(database, location) {
    return database.prepare(`SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`).get(location) !== void 0;
  }
  values(database) {
    const { table } = this;
    return async function* (field) {
      const column = table.columns.find((column2) => column2.name === field);
      if (column === void 0)
        throw new TypeError(`Unknown target field: ${field}`);
      if (!database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ? COLLATE NOCASE").get(table.name, field))
        return;
      for (const row of database.prepare(`SELECT ${column.quotedName} AS value FROM ${table.quotedName}`).iterate())
        yield row.value;
    };
  }
  async clear(writer, committed) {
    var _stack = [];
    try {
      const _lock = __using(_stack, lockWriter(this.path));
      const database = __using(_stack, new DatabaseSync3(this.path));
      database.exec("BEGIN IMMEDIATE");
      try {
        this.writers(database);
        const owner = database.prepare('SELECT "writer" FROM "_elt_writers" WHERE "target" = ?').get(this.table.location)?.writer;
        if (owner !== void 0 && owner !== writer)
          throw new TargetOwnedError(this.table.name, String(owner), writer);
        if (this.exists(database, this.table.location)) {
          database.exec(`DELETE FROM ${this.table.quotedName}`);
          for (const column of this.table.columns) {
            const chunks = SQLiteFileStore.tableName(this.table, column);
            if (column.storesFile && this.exists(database, chunks))
              database.exec(`DELETE FROM ${quote3(chunks)}`);
          }
        }
        database.prepare('DELETE FROM "_elt_writers" WHERE "target" = ?').run(this.table.location);
        database.exec("COMMIT");
        database.exec("BEGIN IMMEDIATE");
        await committed?.(this.values(database));
        database.exec("ROLLBACK");
      } catch (error) {
        if (database.isTransaction)
          database.exec("ROLLBACK");
        throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  // What the table, its reader view and their columns say to readers,
  // rewritten with every load so they follow the stream's schema.
  describe(database) {
    const dataTypes = new Map([
      ...this.table.columns.map(({ name, dataType }) => [name, dataType]),
      ["loaded_at", "timestamp"]
    ]);
    const columns = Object.fromEntries(Object.entries(this.#description.columns).map(([name, description]) => [
      name,
      { description, dataType: dataTypes.get(name) }
    ]));
    describe(database, this.table.name, this.#description.table, columns);
    if (this.table.readerView !== void 0)
      describe(database, this.table.readerView, this.#description.table, columns);
  }
  // Created only when absent and never replaced inside the load: replacing a
  // view readers can see would lock them out until this load commits. A view
  // of other columns or another table is refused rather than adopted.
  installReaderView(database, view) {
    const definition = `CREATE VIEW ${quote3(view)} AS SELECT ${this.fields.join(", ")} FROM ${this.table.quotedName}`;
    const existing = database.prepare('SELECT "type", "sql" FROM sqlite_schema WHERE lower("name") = lower(?)').get(view);
    if (existing === void 0) {
      database.exec(definition);
      return;
    }
    if (existing.type !== "view" || existing.sql !== definition)
      throw new TypeError(`${quote3(view)} is not a view of exactly ${this.table.quotedName}; drop it or delete the database`);
  }
  // Refuses a target another writer owns, or a resumed one that was dropped,
  // and prepares it inside a savepoint, so a refused target leaves the shared
  // transaction as it was.
  prepare(database, { writer, resuming }, loadedAt) {
    const name = quote3(`_elt_stage_${this.hash}`);
    const stage = `temp.${name}`;
    const files = this.table.columns.filter((column) => column.storesFile);
    database.exec("SAVEPOINT prepare");
    let stores;
    try {
      if (resuming && !this.exists(database, this.table.location))
        throw new TargetMissingError(this.table.name, writer);
      this.own(database, writer);
      database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
      database.exec(this.table.createTableSQL);
      stores = files.map((column) => ({
        column,
        store: new SQLiteFileStore(database, this.table, column)
      }));
      for (const { column, store } of stores)
        database.exec(`DELETE FROM ${quote3(store.name)} WHERE "file" NOT IN (SELECT ${column.quotedName} FROM ${this.table.quotedName} WHERE ${column.quotedName} IS NOT NULL)`);
      this.initialize(database);
      if (this.table.readerView !== void 0)
        this.installReaderView(database, this.table.readerView);
      this.describe(database);
      database.exec(`DROP TABLE IF EXISTS ${stage}`);
      database.exec(`CREATE TEMP TABLE ${name} (${seq} INTEGER PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(", ")})`);
      database.exec("RELEASE prepare");
    } catch (error) {
      database.exec("ROLLBACK TO prepare");
      database.exec("RELEASE prepare");
      throw error;
    }
    const columns = this.table.columns.map((column) => column.quotedName);
    const record = database.prepare(`INSERT INTO ${stage} (${op}, ${columns.join(", ")}) VALUES ('R', ${columns.map(() => "?").join(", ")})`);
    const staged = (column) => `SELECT ${column.quotedName} FROM ${stage} WHERE ${column.quotedName} IS NOT NULL`;
    const drop = () => {
      for (const { column, store } of stores)
        database.exec(`DELETE FROM ${quote3(store.name)} WHERE "file" IN (${staged(column)}) AND "file" NOT IN (SELECT ${column.quotedName} FROM ${this.table.quotedName} WHERE ${column.quotedName} IS NOT NULL)`);
      database.exec(`DELETE FROM ${stage}`);
    };
    let replaced = false;
    return {
      values: this.values(database),
      apply: async (operation) => {
        if (operation.type === "DELETE") {
          const [keys, values] = this.deletionKeys(operation.key);
          database.prepare(`INSERT INTO ${stage} (${op}, ${keys.map((column) => column.quotedName).join(", ")}) VALUES ('D', ${keys.map(() => "?").join(", ")})`).run(...values);
          return;
        }
        let data = operation.data;
        for (const { column, store } of stores) {
          const content = Reflect.get(Object(data), column.name);
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [column.name]: await store.save(content)
            };
        }
        record.run(...this.encode(data));
      },
      commit: async () => {
        database.exec("SAVEPOINT merge");
        try {
          if (this.replaces && !replaced)
            this.replace(database);
          this.merge(database, stage, loadedAt);
          drop();
          database.exec("RELEASE merge");
        } catch (error) {
          if (database.isTransaction) {
            database.exec("ROLLBACK TO merge");
            database.exec("RELEASE merge");
          }
          throw error;
        }
        replaced = true;
        database.exec("COMMIT");
        database.exec("BEGIN IMMEDIATE");
      },
      discard: async () => drop(),
      [Symbol.asyncDispose]: async () => {
        drop();
        database.exec(`DROP TABLE ${stage}`);
      }
    };
  }
};

// packages/destinations/sqlite/dist/sqlite-append-writer.js
var SQLiteAppendWriter = class extends SQLiteWriter {
  constructor(configuration, path, table) {
    super(configuration, path, table);
    Object.freeze(this);
  }
  initialize() {
  }
  merge(database, stage, loadedAt) {
    this.append(database, stage, loadedAt);
  }
};

// packages/destinations/sqlite/dist/sqlite-deduplicating-writer.js
var SQLiteDeduplicatingWriter = class extends SQLiteWriter {
  deduplication;
  keys;
  cursor;
  constructor(configuration, path, table) {
    super(configuration, path, table);
    this.deduplication = configuration.deduplication();
    const inferred = SQLiteColumns.fromSchema(configuration.stream.jsonSchema);
    const column = (field) => {
      const selected = table.columns.find((column2) => column2.name === field);
      if (selected === void 0)
        throw new TypeError(`Deduplication requires destination column ${field}`);
      if (selected.kind !== inferred.find((column2) => column2.name === field)?.kind)
        throw new TypeError(`Deduplication column ${field} must preserve the source scalar type`);
      return selected;
    };
    this.keys = Object.freeze(this.deduplication.primaryKey.map(column));
    const { cursorField } = this.deduplication;
    this.cursor = cursorField === void 0 ? void 0 : column(cursorField);
    Object.freeze(this);
  }
  get replaces() {
    return this.configuration.destinationSyncMode === "overwrite_dedup";
  }
  initialize(database) {
    const existing = database.prepare(`PRAGMA table_info(${this.table.quotedName})`).all();
    const tracked = this.cursor === void 0 ? this.keys : [...this.keys, this.cursor];
    for (const column of tracked) {
      if (!existing.some((field) => field.name === column.name && field.type === column.storageType))
        throw new TypeError(`Existing deduplication column ${column.name} has an incompatible storage type`);
    }
    if (this.replaces)
      return;
    if (database.prepare(`SELECT 1 FROM ${this.table.quotedName} WHERE ${tracked.map((column) => `${column.quotedName} IS NULL`).join(" OR ")} LIMIT 1`).get())
      throw new TypeError("Existing deduplication keys and cursors must be non-null");
    this.index(database);
  }
  replace(database) {
    super.replace(database);
    this.index(database);
  }
  index(database) {
    database.exec(`CREATE UNIQUE INDEX ${this.dedupIndex} ON ${this.table.quotedName} (${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(", ")})`);
  }
  // The result of applying the staged operations one at a time: a staged
  // DELETE removes its key, and only records after a key's last DELETE count.
  // replace keeps the newest extraction, so a restated fact overwrites the
  // loaded one; cursor_newer keeps the greatest cursor (the first on ties) and
  // the guard that rejects out-of-order replay.
  merge(database, stage, loadedAt) {
    const keys = this.keys.map((column) => column.quotedName);
    const same = (left, right) => keys.map((key) => `${left}.${key} = ${right}.${key}`).join(" AND ");
    database.exec(`DELETE FROM ${this.table.quotedName} WHERE (${keys.join(", ")}) IN (SELECT ${keys.join(", ")} FROM ${stage} WHERE ${op} = 'D')`);
    const { cursor } = this;
    const guarded = this.configuration.dedupPolicy !== "replace" && cursor !== void 0;
    const order = guarded ? `"staged".${cursor.quotedName} COLLATE BINARY DESC, "staged".${seq}` : `"staged".${seq} DESC`;
    const columns = this.table.columns.map((column) => column.quotedName);
    database.prepare(`WITH "deleted" AS (SELECT ${keys.join(", ")}, max(${seq}) AS "last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(", ")}), "ranked" AS (SELECT "staged".${seq}, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(", ")} ORDER BY ${order}) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN "deleted" ON ${same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."last" IS NULL OR "staged".${seq} > "deleted"."last")) INSERT INTO ${this.table.quotedName} AS "_elt_target" (${this.fields.join(", ")}) SELECT ${columns.join(", ")}, ? FROM ${stage} WHERE ${seq} IN (SELECT ${seq} FROM "ranked" WHERE "_elt_rank" = 1) ORDER BY ${seq} ON CONFLICT (${keys.map((key) => `${key} COLLATE BINARY`).join(", ")}) DO UPDATE SET ${this.fields.map((field) => `${field} = excluded.${field}`).join(", ")}${guarded ? ` WHERE excluded.${cursor.quotedName} COLLATE BINARY > "_elt_target".${cursor.quotedName}` : ""}`).run(loadedAt);
  }
  encode(record) {
    this.deduplication.key(record);
    if (this.cursor !== void 0)
      this.deduplication.cursor(record);
    return super.encode(record);
  }
  deletionKeys(key) {
    this.deduplication.key(key);
    return [this.keys, this.keys.map((column) => column.encode(key))];
  }
};

// packages/destinations/sqlite/dist/sqlite-overwrite-writer.js
var SQLiteOverwriteWriter = class extends SQLiteWriter {
  constructor(configuration, path, table) {
    super(configuration, path, table);
    Object.freeze(this);
  }
  get replaces() {
    return true;
  }
  initialize() {
  }
  merge(database, stage, loadedAt) {
    this.append(database, stage, loadedAt);
  }
};

// packages/destinations/sqlite/dist/sqlite-table.js
var SQLiteTable = class _SQLiteTable extends Target {
  name;
  columns;
  // The name readers query: a documented view of exactly this table.
  readerView;
  constructor(name, columns, readerView) {
    if (!name || name.includes("\0"))
      throw new TypeError("Invalid table name");
    if (/^_elt_/i.test(name))
      throw new TypeError("Table names starting with _elt_ are reserved");
    if (readerView !== void 0) {
      if (!readerView || readerView.includes("\0"))
        throw new TypeError("Invalid view name");
      if (/^_elt_/i.test(readerView))
        throw new TypeError("View names starting with _elt_ are reserved");
      if (readerView.toLowerCase() === name.toLowerCase())
        throw new TypeError("A reader view needs a name of its own");
    }
    if (columns !== void 0 && (!Array.isArray(columns) || columns.length === 0 || !columns.every((column) => column instanceof SQLiteColumn)))
      throw new TypeError("A table requires at least one SQLite column");
    const names = (columns ?? []).map((column) => column.name.toLowerCase());
    if (names.includes("loaded_at"))
      throw new TypeError("loaded_at is reserved for load metadata");
    if (new Set(names).size !== names.length)
      throw new TypeError("Duplicate column names");
    if ((columns ?? []).filter((column) => column.isPrimaryKey).length > 1)
      throw new TypeError("Only one primary-key column is supported");
    const fileReads = (columns ?? []).flatMap((column) => column.fileRead === void 0 ? [] : [column.fileRead]);
    for (const column of columns ?? []) {
      if (column.fileRead === void 0)
        continue;
      if (column.fileRead.outputType === "bytes" ? column.kind !== "blob" : column.kind !== "text")
        throw new TypeError("Original files require a BLOB column; parsed text and stored references require a TEXT column");
    }
    super(fileReads);
    this.name = name;
    this.columns = Object.freeze([...columns ?? []]);
    this.readerView = readerView;
    Object.freeze(this);
  }
  // Loads also keep a view of this table under another name, created with the
  // table and described by the same descriptions, which every column then needs.
  withReaderView(name) {
    return new _SQLiteTable(this.name, this.columns.length === 0 ? void 0 : this.columns, name);
  }
  resolve(stream) {
    if (this.columns.length === 0)
      return new _SQLiteTable(this.name, SQLiteColumns.fromSchema(stream.jsonSchema), this.readerView);
    const properties = stream.jsonSchema.properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties)) {
      for (const column of this.columns) {
        if (column.fileRead === void 0 && !Object.hasOwn(properties, column.name))
          throw new TypeError(`Stream ${stream.name} does not describe column ${column.name}`);
      }
    }
    return this;
  }
  // SQLite compares ASCII identifiers case-insensitively, so one table has one location.
  get location() {
    return this.name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
  }
  get quotedName() {
    return `"${this.name.replaceAll('"', '""')}"`;
  }
  get createTableSQL() {
    if (this.columns.length === 0)
      throw new TypeError("Resolve inferred columns before creating a table");
    return `CREATE TABLE IF NOT EXISTS ${this.quotedName} (${this.columns.map((column) => column.definition).join(", ")}, "loaded_at" TEXT NOT NULL${canonical2("timestamp", '"loaded_at"')}) STRICT`;
  }
};

// packages/destinations/sqlite/dist/sqlite-destination.js
var SQLiteDestination = class extends Destination {
  supportedDestinationSyncModes = Object.freeze([
    "overwrite",
    "append",
    "append_dedup",
    "overwrite_dedup"
  ]);
  path;
  constructor({ path }) {
    super();
    if (!path)
      throw new TypeError("SQLite requires a database path");
    this.path = path === ":memory:" ? path : resolve3(path);
    Object.freeze(this);
  }
  identity(target) {
    return JSON.stringify({ type: "sqlite", path: this.path, target });
  }
  location(target) {
    return `${this.path}#${target.location}`;
  }
  // The writer lock spans all commits; each stream still publishes separately.
  async load() {
    const resources = new DisposableStack();
    let database;
    try {
      resources.use(lockWriter(this.path));
      database = resources.use(new DatabaseSync4(this.path));
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      resources.dispose();
      throw error;
    }
    const loadedAt = (/* @__PURE__ */ new Date()).toISOString();
    return {
      prepare: async (configuration, target, binding) => this.createWriter(configuration, target).prepare(database, binding, loadedAt),
      [Symbol.asyncDispose]: async () => {
        try {
          if (database.isTransaction)
            database.exec("ROLLBACK");
        } finally {
          resources.dispose();
        }
      }
    };
  }
  table(name, configure) {
    return new SQLiteTable(name, configure?.(new SQLiteColumns()));
  }
  createWriter(configuration, target) {
    this.validateConfiguration(configuration, target);
    if (!(target instanceof SQLiteTable))
      throw new TypeError("SQLite requires SQLite table targets");
    if (configuration.syncMode === "incremental" && this.path === ":memory:")
      throw new TypeError("Incremental SQLite requires a persistent destination file");
    const table = target.resolve(configuration.stream);
    switch (configuration.destinationSyncMode) {
      case "append_dedup":
      case "overwrite_dedup":
        return new SQLiteDeduplicatingWriter(configuration, this.path, table);
      case "append":
        return new SQLiteAppendWriter(configuration, this.path, table);
      case "overwrite":
        return new SQLiteOverwriteWriter(configuration, this.path, table);
      default:
        throw new TypeError(`Destination does not support ${configuration.destinationSyncMode}`);
    }
  }
};

// packages/destinations/sqlite/dist/sqlite-sync-history.js
import { DatabaseSync as DatabaseSync5 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-sync-history-schema.js
var attempts = '"_elt_sync_attempts"';
var coverage = '"_elt_extraction_coverage"';
var now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
var status = `"status" TEXT NOT NULL DEFAULT 'running' CHECK ("status" IN ('running', 'succeeded', 'partial', 'failed'))`;
var syncHistoryTables = [
  `CREATE TABLE IF NOT EXISTS ${attempts} (
    "id" INTEGER PRIMARY KEY,
    "connector" TEXT NOT NULL CHECK (trim("connector") <> ''), "source" TEXT NOT NULL,
    "started_at" TEXT NOT NULL, "completed_at" TEXT, ${status}, "error" TEXT,
    CHECK (("status" = 'running') = ("completed_at" IS NULL))
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS "_elt_sync_attempts_connector" ON ${attempts} ("connector", "id" DESC)`,
  `CREATE TABLE IF NOT EXISTS ${coverage} (
    "attempt_id" INTEGER NOT NULL REFERENCES ${attempts}("id"),
    "stream" TEXT NOT NULL, "target_schema" TEXT NOT NULL, "target_table" TEXT NOT NULL,
    "sync_mode" TEXT NOT NULL, "destination_sync_mode" TEXT NOT NULL,
    "description" TEXT NOT NULL CHECK (trim("description") <> ''),
    "selection" TEXT NOT NULL CHECK (json_valid("selection")), ${status},
    "written_count" INTEGER CHECK ("written_count" >= 0),
    "deleted_count" INTEGER CHECK ("deleted_count" >= 0),
    "failures" TEXT NOT NULL DEFAULT '[]' CHECK (json_valid("failures")),
    PRIMARY KEY ("attempt_id", "stream")
  ) STRICT`
];
var queries = {
  sync_attempts: `SELECT "id" AS "attempt_id", "connector", "source", "started_at", "completed_at", "status", "error" FROM ${attempts}`,
  extraction_coverage: `SELECT c."attempt_id", a."connector", a."source", a."started_at", a."completed_at",
      c."stream", c."target_schema", c."target_table",
      EXISTS (SELECT 1 FROM sqlite_schema t WHERE t."type" = 'table' AND lower(t."name") = lower(c."target_table")) AS "target_exists",
      c."sync_mode", c."destination_sync_mode", c."description", c."selection",
      c."status", c."written_count", c."deleted_count", c."failures"
      FROM ${coverage} c JOIN ${attempts} a ON a."id" = c."attempt_id"`,
  sync_status: `WITH "success" AS (
        SELECT "connector", "id", "completed_at", row_number() OVER (PARTITION BY "connector" ORDER BY "completed_at" DESC, "id" DESC) AS "rank"
        FROM ${attempts} WHERE "status" = 'succeeded'
      ), "latest" AS (
        SELECT *, row_number() OVER (PARTITION BY "connector" ORDER BY "id" DESC) AS "rank" FROM ${attempts}
      )
      SELECT a."connector", a."id" AS "latest_attempt_id", a."started_at", a."completed_at", a."status", a."error",
        s."id" AS "last_successful_attempt_id", s."completed_at" AS "last_successful_sync_at"
      FROM "latest" a LEFT JOIN "success" s ON s."connector" = a."connector" AND s."rank" = 1
      WHERE a."rank" = 1 ORDER BY a."connector"`,
  stream_status: `WITH "declared" AS (
        SELECT a."connector", c."stream", c."target_schema", c."target_table", a."id", a."started_at", a."completed_at", c."status",
          row_number() OVER (PARTITION BY a."connector", c."stream" ORDER BY a."id" DESC) AS "rank"
        FROM ${coverage} c JOIN ${attempts} a ON a."id" = c."attempt_id"
      ), "success" AS (
        SELECT a."connector", c."stream", a."id", a."completed_at",
          row_number() OVER (PARTITION BY a."connector", c."stream" ORDER BY a."completed_at" DESC, a."id" DESC) AS "rank"
        FROM ${coverage} c JOIN ${attempts} a ON a."id" = c."attempt_id" WHERE c."status" = 'succeeded'
      )
      SELECT d."connector", d."stream", d."target_schema", d."target_table",
        d."id" AS "latest_attempt_id", d."started_at", d."completed_at", d."status",
        s."id" AS "last_successful_attempt_id", s."completed_at" AS "last_successful_sync_at"
      FROM "declared" d LEFT JOIN "success" s ON s."connector" = d."connector" AND s."stream" = d."stream" AND s."rank" = 1
      WHERE d."rank" = 1 ORDER BY d."connector", d."stream"`
};
var syncHistoryViews = Object.values(syncHistoryRelations).map((relation) => ({ ...relation, query: queries[relation.name] }));

// packages/destinations/sqlite/dist/sqlite-sync-history.js
var busyTimeout = 3e4;
var SQLiteSyncHistory = class extends SyncHistory {
  constructor() {
    super();
    Object.freeze(this);
  }
  validate(connection) {
    this.#path(connection);
  }
  // Every selected stream is declared before reading, even if it produces no
  // rows or the process dies: an unfinished attempt stays running, never success.
  async begin(connection, copies) {
    const path = this.#path(connection);
    const id = write(path, (database) => {
      const attempt2 = database.prepare(`INSERT INTO ${attempts} ("connector", "source", "started_at") VALUES (?, ?, ${now}) RETURNING "id"`).get(connection.name, connection.source.identity);
      if (attempt2 === void 0)
        throw new Error("Sync attempt was not recorded");
      const id2 = Number(attempt2.id);
      const declare = database.prepare(`INSERT INTO ${coverage} ("attempt_id", "stream", "target_schema", "target_table", "sync_mode", "destination_sync_mode", "description", "selection") VALUES (?, ?, 'main', ?, ?, ?, ?, ?)`);
      for (const { copy, coverage: coverage2 } of copies)
        declare.run(id2, copy.from.name, copy.to.name, copy.configuration.syncMode, copy.configuration.destinationSyncMode, coverage2.description, JSON.stringify(coverage2.selection));
      return id2;
    });
    return {
      finish: async (outcomes) => this.#finish(path, id, outcomes),
      fail: async (error) => write(path, (database) => {
        database.prepare(`UPDATE ${coverage} SET "status" = 'failed', "failures" = ? WHERE "attempt_id" = ?`).run(JSON.stringify([{ partition: null, error: message2(error) }]), id);
        database.prepare(`UPDATE ${attempts} SET "status" = 'failed', "completed_at" = ${now}, "error" = ? WHERE "id" = ?`).run(message2(error), id);
      })
    };
  }
  // Creates the history's tables and publishes its views in each file; safe
  // to repeat.
  async install(destinations) {
    for (const destination of destinations)
      write(persistent(destination), (database) => {
        for (const statement of syncHistoryTables)
          database.exec(statement);
        publishSQLiteViews(database, { views: syncHistoryViews });
      });
  }
  #path({ name, destination }) {
    if (!(destination instanceof SQLiteDestination))
      throw new TypeError(`Connection ${name}: SQLite sync history records SQLite destinations only`);
    return persistent(destination);
  }
  #finish(path, id, outcomes) {
    write(path, (database) => {
      const record = database.prepare(`UPDATE ${coverage} SET "status" = ?, "written_count" = ?, "deleted_count" = ?, "failures" = ? WHERE "attempt_id" = ? AND "stream" = ?`);
      for (const outcome of outcomes)
        record.run(copyStatus(outcome), outcome.count, outcome.deleted, JSON.stringify(outcome.failures.map(({ partition, error }) => ({
          partition,
          error: message2(error)
        }))), id, outcome.copy.from.name);
      database.prepare(`UPDATE ${attempts} SET "completed_at" = ${now}, "status" = ?, "error" = ? WHERE "id" = ?`).run(passStatus(outcomes), passError(outcomes), id);
    });
  }
};
function persistent({ path }) {
  if (path === ":memory:")
    throw new TypeError("SQLite sync history requires a destination file");
  return path;
}
function write(path, work) {
  var _stack = [];
  try {
    const database = __using(_stack, new DatabaseSync5(path, { timeout: busyTimeout }));
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work(database);
      database.exec("COMMIT");
      return result;
    } catch (error) {
      if (database.isTransaction)
        database.exec("ROLLBACK");
      throw error;
    }
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}
function message2(error) {
  return error instanceof Error ? error.message : String(error);
}

// apps/apple/connectors/dist/apps/apple-app.js
var AppleApp = class {
  // What to know before narrowing this app, such as how its collections nest.
  note;
  // For an app with no choices: a stream read only to show its store opens.
  probe;
  host;
  constructor(host) {
    this.host = host;
  }
  // The source an import loads from; listing choices reads source(scope).
  importSource(scope) {
    return this.source(scope);
  }
  // The scope an import uses for what its selection leaves out.
  defaultScope() {
    return {};
  }
  narrowsBy(kind) {
    return this.choices.some(({ scope }) => scope === kind);
  }
  guidance() {
    const { grantee } = this.host;
    return [
      ...this.fullDiskAccess ? [
        `Turn on ${grantee} in System Settings \u203A Privacy & Security \u203A Full Disk Access, then quit and reopen ${grantee}. macOS does not ask for this access.`
      ] : [],
      this.access(grantee)
    ].join(" ");
  }
  // What failed, and what macOS access the app needs, for the user to act on.
  failure(error) {
    return `${error instanceof Error ? error.message : String(error)} \u2014 ${this.guidance()}`;
  }
  // What a selection of this app covers, in a person's words.
  describe(scope) {
    const parts = [
      ...this.choices.flatMap(({ scope: ids, title }) => {
        const count = scope[ids]?.length;
        if (count === void 0)
          return [];
        return [
          `${count} ${count === 1 ? title.replace(/(x)es$|s$/, "$1") : title}`
        ];
      }),
      ...scope.startAt ? [`from ${scope.startAt.slice(0, 10)}`] : [],
      // endAt is exclusive: the last day covered is the one before it.
      ...scope.endAt ? [
        `until ${new Date(Date.parse(scope.endAt) - 1).toISOString().slice(0, 10)}`
      ] : []
    ];
    return parts.length === 0 ? "everything" : parts.join(", ");
  }
  // The app and what a selection of it covers, as one phrase.
  titled(scope) {
    const covers = this.describe(scope);
    return covers === "everything" ? this.title : `${this.title} (${covers})`;
  }
  // The reader view of a stream: raw_inlineAttachments reads as
  // inline_attachments.
  view(stream) {
    return stream.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
  // The rows of the streams this app can be narrowed by. Opening the app's
  // store is also what makes macOS ask for access, so a denied app fails
  // here, before anything is selected.
  async choiceRows() {
    const source = this.source(this.defaultScope());
    const catalog = await source.discover();
    const streams = this.probe === void 0 ? this.choices.map(({ stream }) => stream) : [this.probe];
    const rows = /* @__PURE__ */ new Map();
    for await (const message3 of source.read(streams.map((stream) => new CopyConfiguration(catalog.get(stream), {
      syncMode: "full_refresh",
      destinationSyncMode: "overwrite"
    })), /* @__PURE__ */ new Map())) {
      if (message3 instanceof StreamStatus) {
        if (message3.status === "FAILED")
          throw message3.error;
        continue;
      }
      if (!("type" in message3) && message3.stream !== this.probe)
        rows.set(message3.stream, [
          ...rows.get(message3.stream) ?? [],
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every Apple source validates its records against the stream's object schema
          message3.data
        ]);
    }
    return rows;
  }
  async listChoices() {
    const rows = await this.choiceRows();
    return this.choices.map((choice) => ({
      ...choice,
      options: (rows.get(choice.stream) ?? []).map((row) => ({
        id: choice.id(row),
        label: choice.label(row, rows)
      }))
    }));
  }
  // The app's streams, loaded incrementally into raw_<stream> tables of the
  // import directory's data.sqlite and read through documented views, with
  // checkpoints.sqlite and attachment copies in files/ beside it.
  async connection(directory, selection) {
    const { scope, includeAttachments } = selection;
    const source = await this.importSource(scope);
    const narrowed = Object.keys(scope).length > 0;
    const { streams } = await source.discover();
    const withFiles = (stream) => includeAttachments && stream.supportsFileTransfer === true && !this.storeCopies.includes(stream.name);
    mkdirSync(directory, { recursive: true, mode: 448 });
    const destination = new SQLiteDestination({
      path: join2(directory, "data.sqlite")
    });
    const files = new LocalFiles({ directory: join2(directory, "files") });
    const connection = new Connection({
      name: this.name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join2(directory, "checkpoints.sqlite")
      }),
      steps: streams.filter(({ name }) => !(narrowed && this.unscoped.includes(name))).map((stream) => new Copy(stream, destination.table(`raw_${stream.name}`, withFiles(stream) ? (columns) => [
        ...SQLiteColumns.fromSchema(stream.jsonSchema),
        columns.text("attachmentRef").from(stream.file.store(files))
      ] : void 0).withReaderView(this.view(stream.name)), {
        id: `${this.name}:${stream.name}`,
        syncMode: "incremental",
        destinationSyncMode: "append_dedup"
      }))
    });
    return { connection, destination };
  }
};

export {
  Stream,
  Catalog,
  isTimestamp,
  Source,
  Pipeline,
  validateRecords,
  diffSnapshot,
  diffGroupedSnapshot,
  publishSQLiteViews,
  installSQLiteCatalog,
  SQLiteSyncHistory,
  AppleApp
};
