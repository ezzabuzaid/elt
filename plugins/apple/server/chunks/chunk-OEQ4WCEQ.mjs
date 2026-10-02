import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

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
  constructor(stream, status, partition = null, error = void 0) {
    this.stream = stream;
    this.status = status;
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
        for await (const message2 of this.resolved(configuration, this.extract(configuration, state, null, context)))
          if (incremental || !("type" in message2) || message2.type !== "STATE")
            yield message2;
      } catch (error) {
        yield new StreamStatus(name, "FAILED", null, error);
      }
    }
    yield new StreamStatus(name, "ENDED");
  }
  // Keeps each message to the stream whose extract emitted it, and replaces
  // each record's staging path with the file reads it asked for.
  async *resolved(configuration, messages) {
    for await (const message2 of messages) {
      if (message2 instanceof StreamStatus)
        throw new TypeError("Only Source.read reports stream status; extract signals failure by throwing");
      if (message2.stream !== configuration.stream.name)
        throw new TypeError(`Extract for ${configuration.stream.name} emitted ${message2.stream}`);
      if ("type" in message2 || configuration.fileReads.length === 0) {
        yield message2;
        continue;
      }
      if (message2.file !== null && typeof message2.file !== "string")
        throw new TypeError("File extraction must supply a staging path or explicit null");
      const data = message2.data;
      if (data === null || typeof data !== "object" || Array.isArray(data))
        throw new TypeError("File metadata must be an object");
      const output = { ...data };
      const values = /* @__PURE__ */ new Map();
      for (const read of configuration.fileReads) {
        if (Object.keys(data).some((name) => name.toLowerCase() === read.name.toLowerCase()))
          throw new TypeError("File field collides with source metadata");
        let value = null;
        if (message2.file !== null) {
          let pending = values.get(read.parser);
          if (pending === void 0) {
            pending = read.parser === void 0 ? new FileContent(message2.file) : read.parser.parse(message2.file);
            values.set(read.parser, pending);
          }
          value = await pending;
          if (read.parser !== void 0 && value !== null && typeof value !== "string")
            throw new TypeError("Document parser must return text or null");
        }
        Object.defineProperty(output, read.name, { value, enumerable: true });
      }
      yield { stream: message2.stream, data: output };
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
        for await (const message2 of this.resolved(configuration, this.extract(configuration, saved.get(key)?.state ?? null, partition, context))) {
          if ("type" in message2 && message2.type === "STATE") {
            if (!incremental)
              continue;
            latest.set(key, { partition, state: message2.state });
            yield {
              type: "STATE",
              stream: stream.name,
              state: {
                partitions: listed.flatMap((entry) => latest.get(entry.key) ?? [])
              }
            };
            continue;
          }
          assertInPartition(stream, partition, "type" in message2 ? message2.key : message2.data);
          yield message2;
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
  #notify(status) {
    try {
      this.observe?.({
        copy: this.copy,
        status,
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
      for await (const message2 of source.read(prepared.map(({ copy }) => copy.configuration), states)) {
        const replication = byStream.get(validStream(message2));
        if (replication === void 0 || !prepared.includes(replication))
          throw new TypeError(`Source emitted an unselected stream: ${message2.stream}`);
        if (replication.ended)
          throw new TypeError(`Source emitted ${message2.stream} after it ended`);
        try {
          if (message2 instanceof StreamStatus) {
            if (message2.status === "STARTED") {
              if (replication.started)
                throw new TypeError(`Source started ${message2.stream} twice`);
              replication.started = true;
              replication.report();
            } else if (message2.status === "FAILED") {
              if (replication.broken)
                continue;
              await started(replication).discard();
              replication.pending.count = 0;
              replication.pending.deleted = 0;
              replication.failed = true;
              replication.failures.push({
                partition: message2.partition,
                error: message2.error
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
          const operation = validOperation(replication.stream, message2);
          if (operation.type === "STATE") {
            if (!incremental(replication))
              throw new TypeError(`Full refresh stream ${message2.stream} emitted a checkpoint`);
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
function validStream(message2) {
  if (message2 === null || typeof message2 !== "object" || typeof message2.stream !== "string")
    throw new TypeError("Source must emit records with stream and data, DELETE or STATE messages");
  return message2.stream;
}
function validOperation(stream, message2) {
  if ("type" in message2 && message2.type === "STATE" && Object.hasOwn(message2, "state") && !Object.hasOwn(message2, "data")) {
    const state = JSON.parse(JSON.stringify(message2.state));
    if (!isDeepStrictEqual2(state, message2.state))
      throw new TypeError("Checkpoint state must be losslessly JSON serializable");
    wellFormed(state, "Checkpoint state");
    return { type: "STATE", state };
  }
  if ("type" in message2 && message2.type === "DELETE" && Object.hasOwn(message2, "key") && !Object.hasOwn(message2, "data"))
    return { type: "DELETE", key: deletionKey(stream, message2.key) };
  if (!("type" in message2) && "data" in message2 && Object.hasOwn(message2, "data")) {
    if (Object.hasOwn(message2, "file"))
      throw new TypeError("Destinations cannot receive source staging paths");
    wellFormed(message2.data, "Record");
    return { type: "RECORD", data: message2.data };
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
  const missing = Object.entries(columns).flatMap(([column, text]) => text === null ? [column] : []);
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

export {
  DocumentParser,
  FileStorage,
  FileReference,
  FileRead,
  Stream,
  Catalog,
  CopyConfiguration,
  FileContent,
  Target,
  Copy,
  Connection,
  Destination,
  isTimestamp,
  isCalendarDate,
  StreamStatus,
  Source,
  TargetOwnedError,
  TargetMissingError,
  Writer,
  PipelineError,
  Pipeline,
  readerCatalog,
  validateRecords,
  diffSnapshot,
  diffGroupedSnapshot,
  describeTarget,
  undescribed,
  CheckpointStore,
  SyncHistory,
  copyStatus,
  passStatus,
  passError,
  syncHistoryRelations,
  LocalFiles
};
