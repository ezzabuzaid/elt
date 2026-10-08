import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  CheckpointStore,
  Connection,
  Copy,
  CopyConfiguration,
  Destination,
  FileContent,
  FileRead,
  Identifiers,
  LocalFiles,
  Pipeline,
  PipelineError,
  StreamStatus,
  SyncHistory,
  Target,
  TargetOwnedError,
  Writer,
  copyStatus,
  declaredFormat,
  describeTarget,
  isCalendarDate,
  isTimestamp,
  passError,
  passStatus,
  readerCatalog,
  reloadMode,
  syncHistoryRelations
} from "./chunk-AHY2RO53.mjs";
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// packages/connectors/apple/connector/dist/apple-connector.js
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync as readdirSync2 } from "node:fs";
import { join as join6 } from "node:path";

// packages/destinations/sqlite/dist/sqlite-catalog.js
import { DatabaseSync } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-identifiers.js
var SQLiteIdentifiers = class extends Identifiers {
  maxBytes = Infinity;
  ownColumns = ["loaded_at"];
  key(name) {
    return name.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());
  }
};
var identifiers = Object.freeze(new SQLiteIdentifiers());

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
    identifiers.key(String(name)),
    String(type).toLowerCase() || null
  ]));
  const insert = database.prepare(`INSERT INTO ${descriptions} ("relation", "column", "data_type", "description") VALUES (?, ?, ?, ?)`);
  insert.run(relation, "", null, description);
  for (const [column, { description: description2, dataType }] of Object.entries(columns))
    if (description2 !== null)
      insert.run(relation, column, dataType ?? declared.get(identifiers.key(column)) ?? null, description2);
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
import { DatabaseSync as DatabaseSync6 } from "node:sqlite";

// node_modules/@zukhruf/mutex/dist/shared/until-aborted.js
function untilAborted(promise, signal) {
  if (!signal)
    return promise;
  return new Promise((resolve4, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted)
      return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve4(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

// node_modules/@zukhruf/mutex/dist/mutex/acquire-modes/wait-mode.js
var WaitMode = class {
  outcome = "always";
  acquire(store, key, options) {
    return store.acquire(key, options);
  }
};

// node_modules/@zukhruf/mutex/dist/mutex/key.js
var Key = class {
  name;
  #mutex;
  #mode;
  constructor(mutex, name, mode) {
    this.#mutex = mutex;
    this.name = name;
    this.#mode = mode;
  }
  /** Whether the key has a holder now, learned without acquiring it. The holder can change before the answer arrives. */
  isHeld() {
    return this.#mutex.isHeld(this.name);
  }
  run(task, { mode, signal } = {}) {
    return mode === void 0 ? this.#mutex.acquire(this.name, task, { mode: this.#mode, signal }) : this.#mutex.acquire(this.name, task, { mode, signal });
  }
};

// node_modules/@zukhruf/mutex/dist/mutex/lock-lost-error.js
var LockLostError = class extends Error {
  key;
  constructor(key, options) {
    super(`Lost the lock on ${JSON.stringify(key)}: another holder may have been granted it.`, options);
    this.name = "LockLostError";
    this.key = key;
  }
};

// node_modules/@zukhruf/mutex/dist/mutex/mutex.js
var wait = new WaitMode();
var ran = (value) => ({
  always: value,
  maybe: { acquired: true, value }
});
var gaveUp = (key) => ({
  get always() {
    throw new Error(`An acquire mode whose outcome is 'always' gave up on key "${key}".`);
  },
  maybe: { acquired: false }
});
var Mutex = class {
  #store;
  constructor(store) {
    this.#store = store;
  }
  acquire(key, task, { mode, signal } = {}) {
    return mode === void 0 ? this.#run(key, task, wait, signal) : this.#run(key, task, mode, signal);
  }
  /** Whether `key` has a holder now, learned without acquiring it. The holder can change before the answer arrives. */
  isHeld(key) {
    return this.#store.isHeld(key);
  }
  key(name, { mode } = {}) {
    return mode === void 0 ? new Key(this, name, wait) : new Key(this, name, mode);
  }
  // `mode.outcome` has the type O, so TypeScript checks each result below
  // against OutcomeResults<T>[O] and needs no type assertion.
  async #run(key, task, mode, signal) {
    var _stack = [];
    try {
      const handle = await this.#acquire(key, mode, signal);
      if (!handle)
        return gaveUp(key)[mode.outcome];
      const held = __using(_stack, handle, true);
      const { token, signal: lost } = held;
      let value;
      try {
        value = await task({ token, signal: lost });
      } catch (error) {
        if (!lost.aborted || error === lost.reason)
          throw error;
        throw new LockLostError(key, { cause: error });
      }
      if (lost.aborted)
        throw lost.reason;
      return ran(value)[mode.outcome];
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
  // A cancelled caller never takes a key, even a free one. A mode that does
  // not pass the signal on still rejects at once, and gives its late lease back.
  async #acquire(key, mode, signal) {
    signal?.throwIfAborted();
    const acquiring = mode.acquire(this.#store, key, { signal });
    try {
      return await untilAborted(acquiring, signal);
    } catch (error) {
      if (signal?.aborted)
        void giveBack(acquiring);
      throw error;
    }
  }
};
async function giveBack(acquiring) {
  try {
    await (await acquiring)?.[Symbol.asyncDispose]();
  } catch {
  }
}

// node_modules/@zukhruf/mutex/dist/mutex/lease.js
async function leaseFor(key, held, tokens) {
  try {
    const token = await tokens.next(key);
    return {
      token,
      signal: new AbortController().signal,
      [Symbol.asyncDispose]: () => held[Symbol.asyncDispose]()
    };
  } catch (error) {
    await held[Symbol.asyncDispose]();
    throw error;
  }
}

// node_modules/@zukhruf/mutex/dist/mutex/acquire-modes/skip-if-busy-mode.js
var SkipIfBusyMode = class {
  outcome = "maybe";
  #waitAtMost;
  constructor({ waitAtMost = 0 } = {}) {
    if (!(waitAtMost >= 0) || !Number.isFinite(waitAtMost)) {
      throw new RangeError(`waitAtMost must be a finite number of milliseconds >= 0, got ${waitAtMost}.`);
    }
    this.#waitAtMost = waitAtMost;
  }
  async acquire(store, key, { signal }) {
    const lease = await store.tryAcquire(key);
    if (lease || this.#waitAtMost === 0)
      return lease;
    const timeout = AbortSignal.timeout(this.#waitAtMost);
    try {
      return await store.acquire(key, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
    } catch (error) {
      if (timeout.aborted && error === timeout.reason)
        return void 0;
      throw error;
    }
  }
};

// node_modules/@zukhruf/mutex/dist/mutex/acquire-modes/modes.js
var Modes = {
  /** Wait until the key is granted. The task always runs. */
  wait: () => new WaitMode(),
  /** Give up when the key stays busy, at once or after `waitAtMost` ms. The task may not run. */
  skipIfBusy: (options) => new SkipIfBusyMode(options)
};

// node_modules/@zukhruf/mutex/dist/fencing/fencing-token.js
var FencingToken = class {
  value;
  constructor(value) {
    this.value = value;
  }
  isNewerThan(other) {
    return this.value > other.value;
  }
  toString() {
    return this.value.toString();
  }
};

// node_modules/@zukhruf/mutex/dist/fencing/counter-token-source.js
var CounterTokenSource = class {
  #last = 0n;
  async next(_key) {
    this.#last++;
    return new FencingToken(this.#last);
  }
};

// node_modules/@zukhruf/mutex/dist/fencing/file-token-source.js
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// node_modules/@zukhruf/mutex/dist/shared/fs/durable-write.js
import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { dirname } from "node:path";

// node_modules/@zukhruf/mutex/dist/shared/fs/errno.js
function isErrno(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

// node_modules/@zukhruf/mutex/dist/shared/fs/replace-file.js
import { rename } from "node:fs/promises";

// node_modules/@zukhruf/mutex/dist/shared/fs/patiently.js
import { setTimeout as delay } from "node:timers/promises";
var WINDOWS_PATIENCE = 1e3;
function isRefusedForNow(error) {
  return process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].some((code) => isErrno(error, code));
}
async function patiently(operation) {
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRefusedForNow(error) || performance.now() - started > WINDOWS_PATIENCE)
        throw error;
      await delay(Math.min(5 * 2 ** attempt, 100));
    }
  }
}

// node_modules/@zukhruf/mutex/dist/shared/fs/replace-file.js
function replaceFile(draft, path) {
  return patiently(() => rename(draft, path));
}

// node_modules/@zukhruf/mutex/dist/shared/fs/durable-write.js
var draftOf = (path) => `${path}.${randomUUID()}.tmp`;
var draftSuffixLength = draftOf("").length;
async function durableWrite(path, content) {
  const draft = draftOf(path);
  try {
    await writeSynced(draft, content);
    await replaceFile(draft, path);
  } catch (error) {
    await rm(draft, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
}
async function writeSynced(path, content) {
  var _stack = [];
  try {
    const handle = __using(_stack, await open(path, "wx"), true);
    await handle.writeFile(content);
    await handle.sync();
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    var _promise = __callDispose(_stack, _error, _hasError);
    _promise && await _promise;
  }
}
async function syncDirectory(directory) {
  var _stack = [];
  try {
    if (process.platform === "win32")
      return;
    const handle = __using(_stack, await open(directory, "r"), true);
    try {
      await handle.sync();
    } catch (error) {
      if (!isErrno(error, "EINVAL") && !isErrno(error, "ENOTSUP"))
        throw error;
    }
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    var _promise = __callDispose(_stack, _error, _hasError);
    _promise && await _promise;
  }
}

// node_modules/@zukhruf/mutex/dist/shared/fs/safe-file-name.js
import { createHash } from "node:crypto";
var longestFileName = 255;
var visibleStart = 32;
function safeFileName(key, longestSuffix) {
  if (key.isWellFormed()) {
    const encoded = encode(key);
    if (encoded.length + longestSuffix <= longestFileName)
      return encoded;
  }
  const start = encode(key.toWellFormed()).slice(0, visibleStart).replace(/%[0-9A-F]?$/, "");
  const digest = createHash("sha256").update(Buffer.from(key, "utf16le")).digest("hex");
  return `${start}%%${digest}`;
}
function encode(key) {
  return encodeURIComponent(key).replaceAll(".", "%2E");
}

// node_modules/@zukhruf/mutex/dist/fencing/file-token-source.js
var FileTokenSource = class {
  #directory;
  constructor(directory) {
    this.#directory = directory;
  }
  async next(key) {
    await mkdir(this.#directory, { recursive: true });
    const name = safeFileName(key, ".fence".length + draftSuffixLength);
    const path = join(this.#directory, `${name}.fence`);
    const token = await readCounter(path) + 1n;
    await durableWrite(path, token.toString());
    return new FencingToken(token);
  }
};
async function readCounter(path) {
  try {
    return BigInt(await readFile(path, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT"))
      return 0n;
    throw error;
  }
}

// node_modules/@zukhruf/mutex/dist/fencing/epoch-token-source.js
var SEQUENCE_BITS = 32n;
var EPOCH_LIMIT = 1n << 31n;
var SEQUENCE_LIMIT = 1n << SEQUENCE_BITS;

// node_modules/@zukhruf/mutex/dist/shared/latch.js
var Latch = class {
  #opened = Promise.withResolvers();
  open() {
    this.#opened.resolve();
  }
  wait() {
    return this.#opened.promise;
  }
};

// node_modules/@zukhruf/mutex/dist/lock-stores/memory/memory-store.js
var MemoryStore = class {
  /** For each key, the latch that the last caller in line opens when it releases. */
  #lines = /* @__PURE__ */ new Map();
  #tokens;
  constructor({ tokens = new CounterTokenSource() } = {}) {
    this.#tokens = tokens;
  }
  async acquire(key, { signal } = {}) {
    signal?.throwIfAborted();
    const previous = this.#lines.get(key);
    const released = new Latch();
    this.#lines.set(key, released);
    const release = async () => {
      released.open();
      if (this.#lines.get(key) === released)
        this.#lines.delete(key);
    };
    const turn = previous?.wait() ?? Promise.resolve();
    try {
      await untilAborted(turn, signal);
    } catch (error) {
      void turn.then(release);
      throw error;
    }
    return leaseFor(key, { [Symbol.asyncDispose]: release }, this.#tokens);
  }
  async tryAcquire(key) {
    if (this.#lines.has(key))
      return void 0;
    return this.acquire(key);
  }
  /** The first caller in a key's line holds it, so a key with a line is held. */
  async isHeld(key) {
    return this.#lines.has(key);
  }
};

// node_modules/@zukhruf/mutex/dist/shared/is-record.js
var isRecord = (value) => typeof value === "object" && value !== null;

// node_modules/@zukhruf/mutex/dist/local-directory/network-directory-error.js
var NetworkDirectoryError = class extends Error {
  directory;
  /** The network file system the directory is on, for example `NFS`. */
  fileSystem;
  constructor(directory, fileSystem) {
    super(`The lock directory ${JSON.stringify(directory)} is on a network file system (${fileSystem}), where its locks are not shared reliably between machines. Use a local directory.`);
    this.name = "NetworkDirectoryError";
    this.directory = directory;
    this.fileSystem = fileSystem;
  }
};

// node_modules/@zukhruf/mutex/dist/lock-stores/file-system/file-lock-store.js
import { mkdir as mkdir2 } from "node:fs/promises";
import { join as join2 } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { setTimeout as delay2 } from "node:timers/promises";

// node_modules/@zukhruf/mutex/dist/local-directory/local-directory.js
import { statfs } from "node:fs/promises";
import { dirname as dirname2, resolve } from "node:path";
var linuxNetworkFileSystems = /* @__PURE__ */ new Map([
  [0x6969n, "NFS"],
  [0x517bn, "SMB"],
  [0xff534d42n, "CIFS"],
  [0xfe534d42n, "SMB2"],
  [0x00c36400n, "Ceph"],
  [0x5346414fn, "AFS"],
  [0x6b414653n, "kAFS"],
  [0x73757245n, "Coda"],
  [0x564cn, "NCP"],
  [0x7461636fn, "OCFS2"],
  [0x01161970n, "GFS2"],
  [0x0bd00bd0n, "Lustre"],
  [0x01021997n, "9p"]
]);
var local = { kind: "local" };
var unknown = { kind: "unknown" };
var judges = {
  linux: (path) => statfsOfNearest(path).then(({ type }) => {
    const fileSystem = linuxNetworkFileSystems.get(BigInt.asUintN(32, type));
    return fileSystem ? { kind: "network", fileSystem } : local;
  }, () => unknown),
  win32: async (path) => isUncPath(path) ? { kind: "network", fileSystem: "UNC share" } : local
};
var localDirectories = /* @__PURE__ */ new Set();
async function assertLocalDirectory(directory) {
  const path = resolve(directory);
  if (localDirectories.has(path))
    return;
  const judgement = await judges[process.platform]?.(path) ?? local;
  if (judgement.kind === "network") {
    throw new NetworkDirectoryError(directory, judgement.fileSystem);
  }
  if (judgement.kind === "local")
    localDirectories.add(path);
}
async function statfsOfNearest(path) {
  try {
    return await statfs(path, { bigint: true });
  } catch (error) {
    const parent = dirname2(path);
    if (!isErrno(error, "ENOENT") || parent === path)
      throw error;
    return statfsOfNearest(parent);
  }
}
function isUncPath(path) {
  if (/^\\\\[?.]\\/.test(path))
    return /^\\\\[?.]\\UNC\\/i.test(path);
  return path.startsWith("\\\\");
}

// node_modules/@zukhruf/mutex/dist/shared/sqlite/is-busy.js
var SQLITE_BUSY = 5;
function isBusy(error) {
  return error instanceof Error && "errcode" in error && typeof error.errcode === "number" && // The low byte is the primary result code, covering SQLITE_BUSY_* variants.
  (error.errcode & 255) === SQLITE_BUSY;
}

// node_modules/@zukhruf/mutex/dist/shared/sqlite/is-not-a-database.js
var SQLITE_NOTADB = 26;
function isNotADatabase(error) {
  return error instanceof Error && "errcode" in error && typeof error.errcode === "number" && (error.errcode & 255) === SQLITE_NOTADB;
}

// node_modules/@zukhruf/mutex/dist/lock-stores/file-system/file-lock-store.js
var FileLockStore = class {
  #directory;
  #pollInterval;
  #tokens;
  constructor(directory, { pollInterval = 10, tokens = new FileTokenSource(directory) } = {}) {
    this.#directory = directory;
    this.#pollInterval = pollInterval;
    this.#tokens = tokens;
  }
  async acquire(key, { signal } = {}) {
    signal?.throwIfAborted();
    const held = await this.lock(await this.#prepare(key), signal);
    return leaseFor(key, held, this.#tokens);
  }
  async tryAcquire(key) {
    const held = await this.tryLock(await this.#prepare(key));
    return held && leaseFor(key, held, this.#tokens);
  }
  /** Makes no directory: a key in a directory that does not exist has no holder. */
  async isHeld(key) {
    await assertLocalDirectory(this.#directory);
    return this.isHeldAt(this.#pathFor(key));
  }
  async poll(attempt, { signal } = {}) {
    for (; ; ) {
      const result = await attempt();
      if (result !== void 0)
        return result;
      try {
        await delay2(this.#pollInterval, void 0, { signal });
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      }
    }
  }
  /**
   * Serializes evicting a dead holder. Without it, two waiters that saw the
   * same dead holder could each remove a lock the other had just taken. The
   * kernel holds this lock, so a waiter that dies while it evicts frees it at
   * once. Its file stays for the next eviction: deleting it while waiters use
   * it would let two of them lock two different files. Nothing may open that
   * file except through SQLite: closing any other handle to it drops this
   * process's lock without a word.
   */
  async withReclaimLock(path, task) {
    const reclaimPath = `${path}.reclaim`;
    const reclaim = new DatabaseSync2(reclaimPath, { timeout: 0 });
    try {
      if (!claim(reclaim, reclaimPath))
        return;
      try {
        await task();
      } finally {
        reclaim.exec("ROLLBACK");
      }
    } finally {
      reclaim.close();
    }
  }
  async #prepare(key) {
    await assertLocalDirectory(this.#directory);
    await mkdir2(this.#directory, { recursive: true });
    return this.#pathFor(key);
  }
  #pathFor(key) {
    const name = safeFileName(key, ".lock".length + this.longestSuffix);
    return join2(this.#directory, `${name}.lock`);
  }
};
function claim(reclaim, path) {
  try {
    reclaim.exec("PRAGMA journal_mode = MEMORY");
    reclaim.exec("BEGIN EXCLUSIVE");
    return true;
  } catch (error) {
    if (isBusy(error))
      return false;
    if (isNotADatabase(error)) {
      throw new Error(`The reclaim file ${JSON.stringify(path)} was left by an older version of @zukhruf/mutex. Stop the processes that run that version, then delete the file.`, { cause: error });
    }
    throw error;
  }
}

// node_modules/@zukhruf/mutex/dist/shared/fs/atomic-write.js
import { randomUUID as randomUUID2 } from "node:crypto";
import { writeFile } from "node:fs/promises";
async function atomicWrite(path, content) {
  const draft = `${path}.${randomUUID2()}.tmp`;
  await writeFile(draft, content);
  await replaceFile(draft, path);
}

// node_modules/@zukhruf/mutex/dist/lock-stores/file-system/caller.js
import { randomUUID as randomUUID3 } from "node:crypto";
import { hostname } from "node:os";
var Caller = class _Caller {
  pid;
  host;
  id;
  constructor(pid, host, id) {
    this.pid = pid;
    this.host = host;
    this.id = id;
  }
  static current() {
    return new _Caller(process.pid, hostname(), randomUUID3());
  }
  static parse(serialized) {
    const parsed = JSON.parse(serialized);
    if (!isRecord(parsed) || typeof parsed.pid !== "number" || typeof parsed.host !== "string" || typeof parsed.id !== "string") {
      throw new SyntaxError(`Not a lock caller: ${serialized}`);
    }
    return new _Caller(parsed.pid, parsed.host, parsed.id);
  }
  serialize() {
    return JSON.stringify({ pid: this.pid, host: this.host, id: this.id });
  }
};

// node_modules/@zukhruf/mutex/dist/lock-stores/file-system/presence.js
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";

// node_modules/@zukhruf/mutex/dist/shared/sqlite/is-cant-open.js
var SQLITE_CANTOPEN = 14;
function isCantOpen(error) {
  return error instanceof Error && "errcode" in error && typeof error.errcode === "number" && (error.errcode & 255) === SQLITE_CANTOPEN;
}

// node_modules/@zukhruf/mutex/dist/lock-stores/file-system/presence.js
var open2 = /* @__PURE__ */ new Set();
var Presence = class _Presence {
  #path;
  #database;
  constructor(path, database) {
    this.#path = path;
    this.#database = database;
  }
  /** The length of what `pathOf` adds to a record's path. */
  static suffixLength = _Presence.pathOf("", Caller.current()).length;
  /** The presence file of `caller`, whose record is at `record`. */
  static pathOf(record, caller) {
    return `${record}.${caller.id}.presence`;
  }
  static claim(path) {
    const database = new DatabaseSync3(path, { timeout: 0 });
    try {
      database.exec("PRAGMA journal_mode = MEMORY");
      database.exec("BEGIN EXCLUSIVE");
    } catch (error) {
      database.close();
      throw error;
    }
    open2.add(database);
    return new _Presence(path, database);
  }
  /**
   * Whether the caller behind `path` still runs. Reading needs a lock that the
   * caller's exclusive transaction refuses, and opening read-only never creates
   * the file.
   */
  static check(path) {
    let database;
    try {
      database = new DatabaseSync3(path, { readOnly: true, timeout: 0 });
    } catch (error) {
      if (isCantOpen(error) && !existsSync(path))
        return "missing";
      throw error;
    }
    try {
      database.prepare("SELECT count(*) FROM sqlite_schema").get();
      return "gone";
    } catch (error) {
      if (isBusy(error))
        return "present";
      throw error;
    } finally {
      database.close();
    }
  }
  /**
   * Whether `caller`, whom the record at `record` named, still runs. A caller's
   * record goes before its presence file, so a missing presence file is a
   * fault while `stillNamed` says the record names the caller, and means the
   * caller `moved` on when it does not.
   */
  static async judge(record, caller, stillNamed) {
    const path = _Presence.pathOf(record, caller);
    const state = _Presence.check(path);
    if (state !== "missing")
      return state;
    if (await stillNamed())
      throw _Presence.missing(record, path);
    return "moved";
  }
  /** Whether the caller that `readNamed` reads from the record at `record` still runs. Writes nothing. */
  static async isNamedCallerPresent(record, readNamed) {
    for (; ; ) {
      const caller = await readNamed();
      if (!caller)
        return false;
      const state = await _Presence.judge(record, caller, async () => (await readNamed())?.id === caller.id);
      if (state !== "moved")
        return state === "present";
    }
  }
  /** Deletes the file of a presence that has ended. */
  static async delete(path) {
    try {
      await patiently(() => unlink(path));
    } catch (error) {
      throw new Error(`The presence ${JSON.stringify(path)} has ended, but its file could not be deleted. The file locks nothing; delete it by hand.`, { cause: error });
    }
  }
  /** A record names a caller whose presence file does not exist, so nobody can tell whether it runs. */
  static missing(record, path) {
    return new Error(`The lock record ${JSON.stringify(record)} names a caller with no presence file ${JSON.stringify(path)}. An older version of @zukhruf/mutex wrote the record, or someone deleted the file. Stop every process that uses this lock directory, then delete the record.`);
  }
  /** Lets the kernel lock go. The file stays for whoever removes the caller's record. */
  end() {
    open2.delete(this.#database);
    this.#database.exec("ROLLBACK");
    this.#database.close();
  }
  /**
   * Removes the caller's record, then ends this presence and deletes its file.
   * A record that cannot be removed stays, but this presence ends anyway, so
   * the record reads as gone and a waiter evicts it.
   */
  async releaseAfter(removeRecord) {
    try {
      await removeRecord();
    } catch (error) {
      this.end();
      throw error;
    }
    this.end();
    await _Presence.delete(this.#path);
  }
  /** Ends a presence whose record never appeared, or is gone already. */
  async withdraw() {
    this.end();
    await _Presence.delete(this.#path);
  }
};

// node_modules/@zukhruf/mutex/dist/lock-stores/sqlite/sqlite-store.js
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";

// node_modules/@zukhruf/mutex/dist/lock-stores/sqlite/holder-record.js
import { readFileSync } from "node:fs";
import { mkdir as mkdir3, readdir, unlink as unlink2 } from "node:fs/promises";
import { basename, join as join3 } from "node:path";
var HolderRecord = class {
  #folder;
  #path;
  constructor(lockPath) {
    this.#folder = `${lockPath}.holder`;
    this.#path = join3(this.#folder, "caller");
  }
  /**
   * Names this caller as the holder: its presence first, then the record that
   * names it, so a look never finds a record whose presence is still to come.
   */
  async announce() {
    const me = Caller.current();
    await mkdir3(this.#folder, { recursive: true });
    const presence = Presence.claim(Presence.pathOf(this.#path, me));
    try {
      await atomicWrite(this.#path, me.serialize());
    } catch (error) {
      await presence.withdraw();
      throw error;
    }
    await this.#clearEarlierHolders(me);
    return {
      [Symbol.asyncDispose]: () => presence.releaseAfter(() => patiently(() => unlink2(this.#path)))
    };
  }
  /** Whether the holder that the record names still runs. Writes nothing. */
  isPresent() {
    return Presence.isNamedCallerPresent(this.#path, () => this.#read());
  }
  /**
   * Every other file in the folder was left by an earlier holder that stopped
   * before it removed its own. Such a file locks nothing, so a delete that
   * fails leaves it for the next holder and never fails this grant.
   */
  async #clearEarlierHolders(me) {
    const mine = /* @__PURE__ */ new Set([
      basename(this.#path),
      basename(Presence.pathOf(this.#path, me))
    ]);
    const names = await readdir(this.#folder).catch(() => []);
    await Promise.all(names.filter((name) => !mine.has(name)).map((name) => unlink2(join3(this.#folder, name)).catch(() => {
    })));
  }
  async #read() {
    let content;
    try {
      content = await patiently(async () => readFileSync(this.#path, "utf8"));
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        return void 0;
      throw error;
    }
    try {
      return Caller.parse(content);
    } catch (error) {
      if (error instanceof SyntaxError)
        return void 0;
      throw error;
    }
  }
};

// node_modules/@zukhruf/mutex/dist/lock-stores/sqlite/sqlite-store.js
var SqliteStore = class extends FileLockStore {
  /**
   * SQLite keeps the rollback journal of a key's database at `<path>-journal`.
   * The holder folder `<path>.holder` is shorter, so a key keeps the file name
   * that versions without the folder gave it.
   */
  longestSuffix = "-journal".length;
  #inProcess = new MemoryStore();
  async acquire(key, options = {}) {
    const turn = await this.#inProcess.acquire(key, options);
    try {
      return withTurn(await super.acquire(key, options), turn);
    } catch (error) {
      await turn[Symbol.asyncDispose]();
      throw error;
    }
  }
  async tryAcquire(key) {
    const turn = await this.#inProcess.tryAcquire(key);
    if (!turn)
      return void 0;
    try {
      const lease = await super.tryAcquire(key);
      if (lease)
        return withTurn(lease, turn);
    } catch (error) {
      await turn[Symbol.asyncDispose]();
      throw error;
    }
    await turn[Symbol.asyncDispose]();
    return void 0;
  }
  async lock(path, signal) {
    const database = new DatabaseSync4(path, { timeout: 0 });
    try {
      await this.poll(async () => begin(database) ? true : void 0, {
        signal
      });
    } catch (error) {
      database.close();
      throw error;
    }
    return holding(path, database);
  }
  async tryLock(path) {
    const database = new DatabaseSync4(path, { timeout: 0 });
    let begun;
    try {
      begun = begin(database);
    } catch (error) {
      database.close();
      throw error;
    }
    if (begun)
      return holding(path, database);
    database.close();
    return void 0;
  }
  isHeldAt(path) {
    return new HolderRecord(path).isPresent();
  }
};
function begin(database) {
  try {
    database.exec("BEGIN EXCLUSIVE");
    return true;
  } catch (error) {
    if (isBusy(error))
      return false;
    throw error;
  }
}
async function holding(path, database) {
  const record = await new HolderRecord(path).announce().catch((error) => {
    unlock(database);
    throw error;
  });
  return {
    [Symbol.asyncDispose]: async () => {
      try {
        await record[Symbol.asyncDispose]();
      } finally {
        unlock(database);
      }
    }
  };
}
function unlock(database) {
  try {
    database.exec("ROLLBACK");
  } finally {
    database.close();
  }
}
function withTurn(handle, turn) {
  return {
    token: handle.token,
    signal: handle.signal,
    [Symbol.asyncDispose]: async () => {
      try {
        await handle[Symbol.asyncDispose]();
      } finally {
        await turn[Symbol.asyncDispose]();
      }
    }
  };
}

// node_modules/@zukhruf/mutex/dist/leader-election/leader-election.js
import { DatabaseSync as DatabaseSync5 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-checkpoint-store.js
var SQLiteCheckpointStore = class extends CheckpointStore {
  path;
  // One key per replication, in a folder beside the state file. The kernel
  // releases a key when the run holding it exits.
  #locks;
  constructor({ path }) {
    super();
    if (!path || path === ":memory:" || path.includes("\0"))
      throw new TypeError("Checkpoints require a persistent SQLite file");
    this.path = resolve2(path);
    this.#locks = new Mutex(new SqliteStore(`${this.path}.locks`));
    Object.freeze(this);
  }
  // Holds each replication's key in turn, then works. A replication already
  // running fails the run fast; others run in parallel.
  async session(ids, work) {
    const [id, ...rest] = ids;
    if (id === void 0)
      return this.#withFile(work);
    const held = await this.#locks.acquire(id, () => this.session(rest, work), {
      mode: Modes.skipIfBusy()
    });
    if (!held.acquired)
      throw new TypeError(`Checkpoint ${id} is in use by another run`);
    return held.value;
  }
  // Each save commits on its own, so it is durable when it resolves.
  async #withFile(work) {
    var _stack = [];
    try {
      const database = __using(_stack, new DatabaseSync6(this.path, { timeout: 3e4 }));
      chmodSync(this.path, 384);
      database.exec("CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL) STRICT");
      return await work({
        read: async (id) => {
          const saved = database.prepare("SELECT binding, state FROM checkpoints WHERE id = ?").get(id);
          return saved === void 0 ? void 0 : { binding: String(saved.binding), state: String(saved.state) };
        },
        save: async (id, { binding, state }) => {
          database.prepare("INSERT INTO checkpoints (id, binding, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET binding = excluded.binding, state = excluded.state").run(id, binding, state);
        },
        remove: async (id) => {
          database.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
        }
      });
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
};

// packages/destinations/sqlite/dist/sqlite-column.js
var storageTypes = {
  text: "TEXT",
  integer: "INTEGER",
  int64: "INTEGER",
  real: "REAL",
  decimal: "TEXT",
  blob: "BLOB",
  boolean: "INTEGER",
  date: "TEXT",
  timestamp: "TEXT",
  local_timestamp: "TEXT",
  local_time: "TEXT"
};
var formatKinds = {
  "date-time": "timestamp",
  date: "date",
  "date-time-local": "local_timestamp",
  "time-local": "local_time",
  int64: "int64",
  decimal: "decimal",
  base64: "blob"
};
var formatted = /* @__PURE__ */ new Set([
  "int64",
  "decimal",
  "local_timestamp",
  "local_time"
]);
var fraction = (precision) => precision === 0 ? "" : `.${"[0-9]".repeat(precision)}`;
var realSecond = (name) => `strftime('%Y-%m-%dT%H:%M:%S', substr(${name}, 1, 19)) IS substr(${name}, 1, 19)`;
function canonical(kind, name, format) {
  switch (kind) {
    case "boolean":
      return ` CHECK (${name} IN (0, 1))`;
    case "date":
      return ` CHECK (date(${name}) IS ${name})`;
    case "timestamp": {
      const precision = format?.name === "date-time" ? format.precision : 3;
      return precision === 3 ? ` CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', ${name}) IS ${name})` : ` CHECK (${realSecond(name)} AND substr(${name}, 20) GLOB '${fraction(precision)}Z')`;
    }
    case "local_timestamp":
      return format?.name === "date-time-local" ? ` CHECK (${realSecond(name)} AND substr(${name}, 20) GLOB '${fraction(format.precision)}')` : "";
    case "local_time":
      return format?.name === "time-local" ? ` CHECK (time(substr(${name}, 1, 8)) IS substr(${name}, 1, 8) AND substr(${name}, 9) GLOB '${fraction(format.precision)}')` : "";
    default:
      return "";
  }
}
var SQLiteColumn = class _SQLiteColumn {
  // The record field the column holds.
  field;
  // What SQLite calls the column, which the table it belongs to decides.
  name;
  kind;
  // The string format a schema-inferred column keeps, which refines its kind.
  format;
  isPrimaryKey;
  nullable;
  optional;
  // An array of kind, stored as a JSON array in TEXT.
  array;
  fileRead;
  constructor(field, kind, options) {
    if (typeof field !== "string")
      throw new TypeError("A column holds a field named by a string");
    if (!Object.hasOwn(storageTypes, kind))
      throw new TypeError("Unsupported SQLite column type");
    const { format } = options;
    if (format === void 0 ? formatted.has(kind) : formatKinds[format.name] !== kind)
      throw new TypeError(`Column ${field} kind ${kind} must match its format`);
    this.format = format;
    this.array = options.array ?? false;
    if (this.array && (kind === "blob" || options.primaryKey))
      throw new TypeError("Array columns hold scalar values and cannot be keys");
    this.fileRead = options.fileRead;
    if (this.fileRead !== void 0 && (!(this.fileRead instanceof FileRead) || this.fileRead.name !== field))
      throw new TypeError("Column file read must match its field");
    this.field = field;
    this.name = options.name ?? field;
    this.kind = kind;
    this.isPrimaryKey = options.primaryKey;
    this.nullable = !options.primaryKey && options.nullable;
    this.optional = !options.primaryKey && options.optional;
    Object.freeze(this);
  }
  primaryKey() {
    return new _SQLiteColumn(this.field, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: true,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
      name: this.name
    });
  }
  notNull() {
    return new _SQLiteColumn(this.field, this.kind, {
      nullable: false,
      optional: false,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
      name: this.name
    });
  }
  from(file) {
    if (this.array || this.kind !== "blob" && this.kind !== "text")
      throw new TypeError("Files require a BLOB column, parsed TEXT or a stored TEXT reference");
    return new _SQLiteColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.field, file, this.fileRead?.parser),
      name: this.name
    });
  }
  parse(parser) {
    if (this.kind !== "text")
      throw new TypeError("Document parsing requires a TEXT column");
    if (this.fileRead === void 0)
      throw new TypeError("Select a source file before selecting a parser");
    return new _SQLiteColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      fileRead: new FileRead(this.field, this.fileRead.file, parser),
      name: this.name
    });
  }
  // This column as the table names it.
  named(name) {
    return new _SQLiteColumn(this.field, this.kind, {
      nullable: this.nullable,
      optional: this.optional,
      primaryKey: this.isPrimaryKey,
      array: this.array,
      fileRead: this.fileRead,
      format: this.format,
      name
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
    return this.array ? `${this.#typeName}[]` : this.#typeName;
  }
  // The kind with the precision and scale its format declares, as SQL writes
  // them; a timestamp of milliseconds is the plain kind.
  get #typeName() {
    const { format } = this;
    switch (format?.name) {
      case "date-time":
        return format.precision === 3 ? this.kind : `${this.kind}(${format.precision})`;
      case "date-time-local":
      case "time-local":
        return `${this.kind}(${format.precision})`;
      case "decimal":
        return format.precision === void 0 ? this.kind : `${this.kind}(${[format.precision, format.scale ?? []].join(",")})`;
      default:
        return this.kind;
    }
  }
  get definition() {
    const check = this.array ? ` CHECK (json_valid(${this.quotedName}) AND json_type(${this.quotedName}) = 'array')` : canonical(this.kind, this.quotedName, this.format);
    return `${this.quotedName} ${this.storageType}${this.isPrimaryKey ? " PRIMARY KEY NOT NULL" : ""}${check}`;
  }
  encode(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record))
      throw new TypeError(`Record is missing field ${JSON.stringify(this.field)}`);
    if (!Object.hasOwn(record, this.field)) {
      if (this.optional)
        return null;
      throw new TypeError(`Record is missing field ${JSON.stringify(this.field)}`);
    }
    const value = Reflect.get(record, this.field);
    if (value === null && this.nullable)
      return null;
    const { format } = this;
    if (this.array) {
      if (Array.isArray(value) && value.every((element) => this.#element(element)))
        return JSON.stringify(value);
      throw new TypeError(`Field ${JSON.stringify(this.field)} requires an array of ${this.kind}${this.nullable ? " or null" : " (not null)"}`);
    }
    if (format !== void 0) {
      if (typeof value === "string" && format.accepts(value)) {
        if (format.name === "int64")
          return BigInt(value);
        if (format.name === "base64")
          return Buffer.from(value, "base64");
        return value;
      }
      throw new TypeError(`Field ${JSON.stringify(this.field)} requires a canonical ${format.name} value${this.nullable ? " or null" : " (not null)"}`);
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
    throw new TypeError(`Field ${JSON.stringify(this.field)} requires ${this.kind}${this.nullable ? " or null" : " (not null)"}`);
  }
  // Whether a JSON array element keeps this kind's value exactly.
  #element(value) {
    if (this.format !== void 0)
      return typeof value === "string" && this.format.accepts(value);
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
      return format === null ? "text" : formatKinds[format.name];
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
  // Scalars, and arrays of scalars as JSON arrays in TEXT. String formats
  // keep their kind, as in Postgres.
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
      const items = array ? field.items : void 0;
      if (array && items === void 0)
        throw new TypeError(`Unsupported JSON Schema items for field ${name}`);
      const format = declaredFormat(items ?? field);
      return new SQLiteColumn(name, scalarKind(name, items?.type ?? valueType, format), {
        nullable: types.includes("null"),
        optional: !requiredFields.has(name),
        primaryKey: false,
        array,
        format: format ?? void 0
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
import { DatabaseSync as DatabaseSync8 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-writer.js
import { createHash as createHash3 } from "node:crypto";
import { DatabaseSync as DatabaseSync7 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-file-store.js
import { createHash as createHash2 } from "node:crypto";
var quote2 = (name) => `"${name.replaceAll('"', '""')}"`;
var tablePrefix = "_elt_files_";
var chunks = '("file" INTEGER NOT NULL, "n" INTEGER NOT NULL, "bytes" BLOB NOT NULL, PRIMARY KEY ("file", "n")) STRICT';
var SQLiteFileStore = class _SQLiteFileStore {
  static chunkSize = 4 * 1024 * 1024;
  name;
  #database;
  #table;
  #column;
  #staged;
  constructor(database, table, column) {
    this.#database = database;
    this.#table = table;
    this.#column = column;
    this.name = _SQLiteFileStore.tableName(table, column);
    this.#staged = quote2(`${tablePrefix}stage_${this.name.slice(tablePrefix.length)}`);
  }
  // A hash of the table and column, as SQLite compares them: joined as text,
  // table a_b with column c and table a with column b_c would share chunks
  // and prune each other's.
  static tableName(table, column) {
    const key = createHash2("sha256").update(JSON.stringify([table.location, identifiers.key(column.name)])).digest("hex").slice(0, 40);
    return `${tablePrefix}${key}`;
  }
  #exists(location) {
    return this.#database.prepare(`SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`).get(location) !== void 0;
  }
  get published() {
    return this.#exists(this.name);
  }
  stage() {
    this.#database.exec(`DROP TABLE IF EXISTS temp.${this.#staged}`);
    this.#database.exec(`CREATE TEMP TABLE ${this.#staged} ${chunks}`);
  }
  // An empty file still stores one empty chunk, so its id stays reserved. Ids
  // continue after both the published and the staged chunks.
  async save(content) {
    const highest = (table) => Number(this.#database.prepare(`SELECT coalesce(max("file"), 0) AS "file" FROM ${table}`).get()?.file);
    const file = Math.max(this.published ? highest(quote2(this.name)) : 0, highest(`temp.${this.#staged}`)) + 1;
    const insert = this.#database.prepare(`INSERT INTO temp.${this.#staged} ("file", "n", "bytes") VALUES (?, ?, ?)`);
    let n = 0;
    for await (const chunk of content.chunks(_SQLiteFileStore.chunkSize))
      insert.run(file, n++, chunk);
    if (n === 0)
      insert.run(file, 0, new Uint8Array());
    return file;
  }
  // Moves the staged chunks into the store, inside a commit, and attaches the
  // triggers to the target once it exists. A reload swaps in a table without
  // them, which its next commit attaches again.
  publish() {
    const table = quote2(this.name);
    const column = this.#column.quotedName;
    this.#database.exec(`CREATE TABLE IF NOT EXISTS ${table} ${chunks}`);
    if (this.#exists(this.#table.location)) {
      this.#database.exec(`CREATE TRIGGER IF NOT EXISTS ${quote2(`${this.name}_delete`)} AFTER DELETE ON ${this.#table.quotedName} BEGIN DELETE FROM ${table} WHERE "file" = old.${column}; END`);
      this.#database.exec(`CREATE TRIGGER IF NOT EXISTS ${quote2(`${this.name}_update`)} AFTER UPDATE OF ${column} ON ${this.#table.quotedName} WHEN old.${column} IS NOT new.${column} BEGIN DELETE FROM ${table} WHERE "file" = old.${column}; END`);
    }
    this.#database.exec(`INSERT INTO ${table} SELECT * FROM temp.${this.#staged}`);
    this.discard();
  }
  discard() {
    this.#database.exec(`DELETE FROM temp.${this.#staged}`);
  }
  unstage() {
    this.#database.exec(`DROP TABLE IF EXISTS temp.${this.#staged}`);
  }
};

// packages/destinations/sqlite/dist/sqlite-writer.js
function lockWriter(path) {
  const lock = new DatabaseSync7(path === ":memory:" ? path : `${path}.writer-lock`);
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
    const { missing } = this.#description;
    if (missing.length > 0)
      throw new TypeError(`Reader view ${table.readerView} needs JSON Schema descriptions for ${missing.join(", ")} of stream ${this.stream.name}`);
  }
  // Refuses, before anything is read, stored rows the load cannot keep.
  inspect(_database) {
  }
  // What a reload's hidden target needs once it is created, before the first
  // merge fills it, and once it takes the target's name.
  build(_database, _into) {
  }
  adopt(_database) {
  }
  // Inserts each staged record, in order.
  append(database, stage, loadedAt, into) {
    database.prepare(`INSERT INTO ${into} (${this.fields.join(", ")}) SELECT ${this.table.columns.map((column) => column.quotedName).join(", ")}, ? FROM ${stage} WHERE ${op} = 'R' ORDER BY ${seq}`).run(loadedAt);
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
  // The owner lives beside the table it guards. A dropped table releases it,
  // since nothing it held remains.
  writers(database) {
    database.exec('CREATE TABLE IF NOT EXISTS "_elt_writers" ("target" TEXT PRIMARY KEY, "writer" TEXT NOT NULL) STRICT');
  }
  // Refuses, before anything is read, a target another writer owns.
  #refuse(database, writer) {
    if (!this.exists(database, "_elt_writers"))
      return;
    const owner = database.prepare(`SELECT "writer" FROM "_elt_writers" WHERE "target" = ? AND "target" IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`).get(this.table.location)?.writer;
    if (owner !== void 0 && owner !== writer)
      throw new TargetOwnedError(this.table.name, String(owner), writer);
  }
  // Records the owner with the target's first commit; prepare refused any
  // other, and the writer lock keeps one in until the load ends.
  own(database, writer) {
    this.writers(database);
    database.exec(`DELETE FROM "_elt_writers" WHERE "target" NOT IN (SELECT lower("name") FROM sqlite_schema WHERE "type" = 'table')`);
    database.prepare('INSERT INTO "_elt_writers" ("target", "writer") VALUES (?, ?) ON CONFLICT ("target") DO NOTHING').run(this.table.location, writer);
  }
  exists(database, location) {
    return database.prepare(`SELECT 1 FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = ?`).get(location) !== void 0;
  }
  // The field's values in each of the tables, which while a reload is open
  // are the target and its hidden target: both rows still refer to files.
  values(database, tables) {
    const { table } = this;
    return async function* (field) {
      const column = table.columns.find((column2) => column2.field === field);
      if (column === void 0)
        throw new TypeError(`Unknown target field: ${field}`);
      for (const name of tables()) {
        if (!database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ? COLLATE NOCASE").get(name, column.name))
          continue;
        for (const row of database.prepare(`SELECT ${column.quotedName} AS value FROM ${quote3(name)}`).iterate())
          yield row.value;
      }
    };
  }
  async clear(writer, committed) {
    var _stack = [];
    try {
      const _lock = __using(_stack, lockWriter(this.path));
      const database = __using(_stack, new DatabaseSync7(this.path, { timeout: 3e4 }));
      database.exec("BEGIN IMMEDIATE");
      try {
        this.writers(database);
        const owner = database.prepare('SELECT "writer" FROM "_elt_writers" WHERE "target" = ?').get(this.table.location)?.writer;
        if (owner !== void 0 && owner !== writer)
          throw new TargetOwnedError(this.table.name, String(owner), writer);
        if (this.exists(database, this.table.location)) {
          database.exec(`DELETE FROM ${this.table.quotedName}`);
          database.exec(`DROP TABLE IF EXISTS ${quote3(this.#hiddenName)}`);
          for (const column of this.table.columns) {
            const chunks2 = SQLiteFileStore.tableName(this.table, column);
            if (column.storesFile && this.exists(database, chunks2))
              database.exec(`DELETE FROM ${quote3(chunks2)}`);
          }
        }
        database.prepare('DELETE FROM "_elt_writers" WHERE "target" = ?').run(this.table.location);
        database.exec("COMMIT");
        database.exec("BEGIN IMMEDIATE");
        await committed?.(this.values(database, () => [this.table.name]));
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
  #viewDefinition(view) {
    return `CREATE VIEW ${quote3(view)} AS SELECT ${this.fields.join(", ")} FROM ${this.table.quotedName}`;
  }
  // Refuses, before anything is read, a view of other columns or another
  // table, rather than adopting it. A stale table's view still selects the
  // stored columns, which evolving the table replaces.
  #refuseReaderView(database, view, stale) {
    const existing = database.prepare('SELECT "type", "sql" FROM sqlite_schema WHERE lower("name") = lower(?)').get(view);
    if (existing === void 0)
      return;
    const sql = String(existing.sql);
    const ours = stale ? sql.startsWith(`CREATE VIEW ${quote3(view)} AS SELECT `) && sql.endsWith(` FROM ${this.table.quotedName}`) : sql === this.#viewDefinition(view);
    if (existing.type !== "view" || !ours)
      throw new TypeError(`${quote3(view)} is not a view of exactly ${this.table.quotedName}; drop it or delete the database`);
  }
  // Created only when absent and never replaced by a commit: replacing a view
  // readers can see would lock them out. prepare refused any view not this
  // load's own.
  installReaderView(database, view) {
    if (database.prepare('SELECT 1 FROM sqlite_schema WHERE lower("name") = lower(?)').get(view) === void 0)
      database.exec(this.#viewDefinition(view));
  }
  // The target as its first commit makes it: its owner, the table and the
  // index its mode owns, its reader view and its descriptions.
  #create(database, writer, replacing) {
    this.own(database, writer);
    database.exec(`DROP INDEX IF EXISTS ${this.dedupIndex}`);
    database.exec(this.table.createTableSQL);
    this.initialize(database, replacing);
    if (this.table.readerView !== void 0)
      this.installReaderView(database, this.table.readerView);
    this.describe(database);
  }
  // The rows of one partition, or every row when the stream is not
  // partitioned, as a WHERE clause over the target's or the stage's columns.
  #scope(partition) {
    if (partition === null)
      return ["", []];
    const columns = Object.keys(partition).map((field) => {
      const column = this.table.columns.find((column2) => column2.field === field);
      if (column === void 0)
        throw new TypeError(`Resetting a partition requires destination column ${field}`);
      return column;
    });
    return [
      ` WHERE ${columns.map((column) => `${column.quotedName} = ?`).join(" AND ")}`,
      columns.map((column) => column.encode(partition))
    ];
  }
  // A reload's hidden target, beside the target and invisible to readers.
  get #hiddenName() {
    return `_elt_next_${this.hash}`;
  }
  // Whether a stored table is the one the stream needs, by the text SQLite
  // keeps of its CREATE TABLE, which a CHECK alone can change.
  #fit(database, name) {
    const stored = database.prepare(`SELECT "sql" FROM sqlite_schema WHERE "type" = 'table' AND lower("name") = lower(?)`).get(name)?.sql;
    if (stored === void 0)
      return "missing";
    return stored === `CREATE TABLE ${this.table.definition(quote3(name))}` ? "fits" : "stale";
  }
  // Brings a stored table the stream no longer fits to its shape, keeping
  // every row: SQLite cannot change a column's type or constraints in place,
  // so the rows move into a table of the new definition, column by name, a
  // column the stream added reading NULL and one it dropped left behind. A
  // value the new definition refuses fails the load, naming the column, and
  // the transaction leaves the table as it was.
  #evolve(database, into) {
    const stored = new Map(database.prepare('SELECT "name" FROM pragma_table_info(?)').all(this.table.name).map(({ name }) => [
      identifiers.key(String(name)),
      quote3(String(name))
    ]));
    const sources = [...this.table.columns.map(({ name }) => name), "loaded_at"].map((name) => stored.get(identifiers.key(name)) ?? "NULL").join(", ");
    if (this.table.readerView !== void 0)
      database.exec(`DROP VIEW IF EXISTS ${quote3(this.table.readerView)}`);
    database.exec(`CREATE TABLE ${this.table.definition(into)}`);
    try {
      database.exec(`INSERT INTO ${into} (${this.fields.join(", ")}) SELECT ${sources} FROM ${this.table.quotedName}`);
    } catch (cause) {
      throw new TypeError(`The rows stored in ${this.table.quotedName} do not fit the new shape of stream ${this.stream.name}: ${cause instanceof Error ? cause.message : String(cause)}. Clear the copy to load it again, or change the stream so they fit.`, { cause });
    }
    database.exec(`DROP TABLE ${this.table.quotedName}`);
    database.exec(`ALTER TABLE ${into} RENAME TO ${this.table.quotedName}`);
    this.initialize(database, false);
    if (this.table.readerView !== void 0)
      this.installReaderView(database, this.table.readerView);
    this.describe(database);
  }
  // Refuses, in one short transaction, a target another writer owns, a
  // reader view not its own and stored rows it cannot keep, evolves a stored
  // table the stream no longer fits unless the load overwrites it, and stages
  // in TEMP. Nothing else reaches the database until a commit. A load into the
  // target creates it, or adopts the stored one, at its first commit; a reload
  // leaves it to readers as it is, merges into a hidden target from its first
  // commit, and swaps that in at complete().
  prepare(database, { writer, reloading }, loadedAt) {
    const name = quote3(`_elt_stage_${this.hash}`);
    const stage = `temp.${name}`;
    const hidden = quote3(this.#hiddenName);
    const stores = this.table.columns.filter((column) => column.storesFile).map((column) => ({
      column,
      store: new SQLiteFileStore(database, this.table, column)
    }));
    let mode;
    const open3 = () => mode === "reload" || mode === "continue";
    const into = () => open3() ? hidden : this.table.quotedName;
    const tables = () => [this.table.name, ...open3() ? [this.#hiddenName] : []].filter((table) => this.exists(database, identifiers.key(table)));
    const referenced = (column) => tables().map((table) => `SELECT ${column.quotedName} FROM ${quote3(table)} WHERE ${column.quotedName} IS NOT NULL`).join(" UNION ") || "SELECT NULL WHERE 0";
    const prune = () => {
      for (const { column, store } of stores)
        if (store.published)
          database.exec(`DELETE FROM ${quote3(store.name)} WHERE "file" NOT IN (${referenced(column)})`);
    };
    database.exec("BEGIN IMMEDIATE");
    try {
      this.#refuse(database, writer);
      const target = this.#fit(database, this.table.name);
      mode = reloadMode({
        reloading,
        destinationSyncMode: this.configuration.destinationSyncMode,
        target,
        hidden: this.#fit(database, this.#hiddenName)
      });
      if (mode !== "continue")
        database.exec(`DROP TABLE IF EXISTS ${hidden}`);
      if (!open3() && this.table.readerView !== void 0)
        this.#refuseReaderView(database, this.table.readerView, target === "stale");
      if (mode === "evolve") {
        this.#evolve(database, hidden);
        mode = "load";
      }
      if (mode === "load" && !this.replaces)
        this.inspect(database);
      database.exec(`DROP TABLE IF EXISTS ${stage}`);
      database.exec(`CREATE TEMP TABLE ${name} (${seq} INTEGER PRIMARY KEY, ${op} TEXT NOT NULL, ${this.table.columns.map((column) => `${column.quotedName} ${column.storageType}`).join(", ")})`);
      for (const { store } of stores)
        store.stage();
      database.exec("COMMIT");
    } catch (error) {
      if (database.isTransaction)
        database.exec("ROLLBACK");
      throw error;
    }
    const fresh = mode === "create" || mode === "reload";
    let opened = mode === "continue";
    const columns = this.table.columns.map((column) => column.quotedName);
    const record = database.prepare(`INSERT INTO ${stage} (${op}, ${columns.join(", ")}) VALUES ('R', ${columns.map(() => "?").join(", ")})`);
    const staged = (column) => `SELECT ${column.quotedName} FROM ${stage} WHERE ${column.quotedName} IS NOT NULL`;
    let resets = [];
    const drop = () => {
      for (const { column, store } of stores) {
        if (store.published)
          database.exec(`DELETE FROM ${quote3(store.name)} WHERE "file" IN (${staged(column)}) AND "file" NOT IN (${referenced(column)})`);
        store.discard();
      }
      database.exec(`DELETE FROM ${stage}`);
      resets = [];
    };
    const commit = (work) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        work();
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction)
          database.exec("ROLLBACK");
        throw error;
      }
    };
    let committed = false;
    return {
      fresh,
      get reloading() {
        return open3();
      },
      values: this.values(database, tables),
      apply: async (operation) => {
        if (operation.type === "RESET") {
          const { partition } = operation;
          if (partition === null) {
            drop();
            mode = "reload";
            opened = false;
            return;
          }
          const [rows, values] = this.#scope(partition);
          database.prepare(`DELETE FROM ${stage}${rows}`).run(...values);
          resets.push(partition);
          return;
        }
        if (operation.type === "DELETE") {
          const [keys, values] = this.deletionKeys(operation.key);
          database.prepare(`INSERT INTO ${stage} (${op}, ${keys.map((column) => column.quotedName).join(", ")}) VALUES ('D', ${keys.map(() => "?").join(", ")})`).run(...values);
          return;
        }
        let data = operation.data;
        for (const { column, store } of stores) {
          const content = Reflect.get(Object(data), column.field);
          if (content instanceof FileContent)
            data = {
              ...Object(data),
              [column.field]: await store.save(content)
            };
        }
        record.run(...this.encode(data));
      },
      commit: async () => {
        commit(() => {
          if (open3()) {
            if (!opened) {
              database.exec(`DROP TABLE IF EXISTS ${hidden}`);
              database.exec(`CREATE TABLE ${this.table.definition(hidden)}`);
              this.build(database, hidden);
            }
            if (!committed)
              this.own(database, writer);
          } else if (!committed) {
            this.#create(database, writer, this.replaces);
            if (this.replaces)
              this.replace(database);
          }
          for (const partition of resets) {
            const [rows, values] = this.#scope(partition);
            database.prepare(`DELETE FROM ${into()}${rows}`).run(...values);
          }
          for (const { store } of stores)
            store.publish();
          this.merge(database, stage, loadedAt, into());
          if (resets.length > 0)
            prune();
          drop();
        });
        opened = open3();
        committed = true;
      },
      complete: async () => {
        if (!open3())
          return;
        commit(() => {
          if (this.table.readerView !== void 0)
            database.exec(`DROP VIEW IF EXISTS ${quote3(this.table.readerView)}`);
          database.exec(`DROP TABLE IF EXISTS ${this.table.quotedName}`);
          database.exec(`ALTER TABLE ${hidden} RENAME TO ${this.table.quotedName}`);
          this.adopt(database);
          if (this.table.readerView !== void 0)
            this.installReaderView(database, this.table.readerView);
          this.describe(database);
          mode = "load";
          prune();
        });
        opened = false;
      },
      discard: async () => drop(),
      [Symbol.asyncDispose]: async () => {
        drop();
        database.exec(`DROP TABLE ${stage}`);
        for (const { store } of stores)
          store.unstage();
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
  merge(database, stage, loadedAt, into) {
    this.append(database, stage, loadedAt, into);
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
      const selected = table.columns.find((column2) => column2.field === field);
      if (selected === void 0)
        throw new TypeError(`Deduplication requires destination column ${field}`);
      if (selected.dataType !== inferred.find((column2) => column2.field === field)?.dataType)
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
  // A stored table the load merges into must hold keys and cursors of the
  // stream's types, none null, and no key twice, which its index will forbid.
  inspect(database) {
    const existing = database.prepare(`PRAGMA table_info(${this.table.quotedName})`).all();
    const tracked = this.cursor === void 0 ? this.keys : [...this.keys, this.cursor];
    for (const column of tracked) {
      if (!existing.some((field) => field.name === column.name && field.type === column.storageType))
        throw new TypeError(`Existing deduplication column ${column.name} has an incompatible storage type`);
    }
    if (database.prepare(`SELECT 1 FROM ${this.table.quotedName} WHERE ${tracked.map((column) => `${column.quotedName} IS NULL`).join(" OR ")} LIMIT 1`).get())
      throw new TypeError("Existing deduplication keys and cursors must be non-null");
    if (database.prepare(`SELECT 1 FROM ${this.table.quotedName} GROUP BY ${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(", ")} HAVING count(*) > 1 LIMIT 1`).get())
      throw new TypeError("Existing rows repeat a deduplication key; replace them with overwrite_dedup before deduplicating incrementally");
  }
  // A replacing load keeps none of the stored rows: its index is built once
  // the commit has emptied the table.
  initialize(database, replacing) {
    if (!replacing)
      this.index(database);
  }
  replace(database) {
    super.replace(database);
    this.index(database);
  }
  index(database, name = this.dedupIndex, on = this.table.quotedName) {
    database.exec(`CREATE UNIQUE INDEX ${name} ON ${on} (${this.keys.map((column) => `${column.quotedName} COLLATE BINARY`).join(", ")})`);
  }
  // A reload's hidden target merges on its key from its first commit; SQLite
  // cannot rename an index, so the target's own is built once it is swapped in.
  get #provisionalIndex() {
    return `${this.dedupIndex.slice(0, -1)}_next"`;
  }
  build(database, into) {
    this.index(database, this.#provisionalIndex, into);
  }
  adopt(database) {
    database.exec(`DROP INDEX IF EXISTS ${this.#provisionalIndex}`);
    this.index(database);
  }
  // The result of applying the staged operations one at a time: a staged
  // DELETE removes its key, and only records after a key's last DELETE count.
  // replace keeps the newest extraction, so a restated fact overwrites the
  // loaded one; cursor_newer keeps the greatest cursor (the first on ties) and
  // the guard that rejects out-of-order replay.
  merge(database, stage, loadedAt, into) {
    const keys = this.keys.map((column) => column.quotedName);
    const same = (left, right) => keys.map((key) => `${left}.${key} = ${right}.${key}`).join(" AND ");
    database.exec(`DELETE FROM ${into} WHERE (${keys.join(", ")}) IN (SELECT ${keys.join(", ")} FROM ${stage} WHERE ${op} = 'D')`);
    const { cursor } = this;
    const guarded = this.configuration.dedupPolicy !== "replace" && cursor !== void 0;
    const order = guarded ? `"staged".${cursor.quotedName} COLLATE BINARY DESC, "staged".${seq}` : `"staged".${seq} DESC`;
    const columns = this.table.columns.map((column) => column.quotedName);
    database.prepare(`WITH "deleted" AS (SELECT ${keys.join(", ")}, max(${seq}) AS "_elt_last" FROM ${stage} WHERE ${op} = 'D' GROUP BY ${keys.join(", ")}), "ranked" AS (SELECT "staged".${seq}, row_number() OVER (PARTITION BY ${keys.map((key) => `"staged".${key}`).join(", ")} ORDER BY ${order}) AS "_elt_rank" FROM ${stage} AS "staged" LEFT JOIN "deleted" ON ${same('"deleted"', '"staged"')} WHERE "staged".${op} = 'R' AND ("deleted"."_elt_last" IS NULL OR "staged".${seq} > "deleted"."_elt_last")) INSERT INTO ${into} AS "_elt_target" (${this.fields.join(", ")}) SELECT ${columns.join(", ")}, ? FROM ${stage} WHERE ${seq} IN (SELECT ${seq} FROM "ranked" WHERE "_elt_rank" = 1) ORDER BY ${seq} ON CONFLICT (${keys.map((key) => `${key} COLLATE BINARY`).join(", ")}) DO UPDATE SET ${this.fields.map((field) => `${field} = excluded.${field}`).join(", ")}${guarded ? ` WHERE excluded.${cursor.quotedName} COLLATE BINARY > "_elt_target".${cursor.quotedName}` : ""}`).run(loadedAt);
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
  merge(database, stage, loadedAt, into) {
    this.append(database, stage, loadedAt, into);
  }
};

// packages/destinations/sqlite/dist/sqlite-table.js
var SQLiteTable = class _SQLiteTable extends Target {
  name;
  columns;
  // The name readers query: a documented view of exactly this table.
  readerView;
  constructor(name, columns, readerView) {
    if (typeof name !== "string" || readerView !== void 0 && typeof readerView !== "string")
      throw new TypeError("A table and its view are named by strings");
    const table = identifiers.relation(name);
    const view = readerView === void 0 ? void 0 : identifiers.relation(readerView);
    if (view !== void 0 && identifiers.key(view) === identifiers.key(table))
      throw new TypeError("A reader view needs a name of its own");
    if (columns !== void 0 && (!Array.isArray(columns) || columns.length === 0 || !columns.every((column) => column instanceof SQLiteColumn)))
      throw new TypeError("A table requires at least one SQLite column");
    const fields = (columns ?? []).map((column) => column.field);
    if (new Set(fields).size !== fields.length)
      throw new TypeError("Two columns hold one field");
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
    this.name = table;
    this.columns = Object.freeze(identifiers.columns(columns ?? []).map(([column, stored]) => column.named(stored)));
    this.readerView = view;
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
    const { properties } = stream.jsonSchema;
    if (properties === void 0)
      return this;
    for (const column of this.columns)
      if (column.fileRead === void 0 && !Object.hasOwn(properties, column.field))
        throw new TypeError(`Stream ${stream.name} does not describe field ${column.field}`);
    return this;
  }
  // SQLite takes names that differ only in ASCII case for one, so one table
  // has one location.
  get location() {
    return identifiers.key(this.name);
  }
  get quotedName() {
    return `"${this.name.replaceAll('"', '""')}"`;
  }
  get createTableSQL() {
    return `CREATE TABLE IF NOT EXISTS ${this.definition(this.quotedName)}`;
  }
  // A table named name with these columns, as CREATE TABLE spells it.
  definition(name) {
    if (this.columns.length === 0)
      throw new TypeError("Resolve inferred columns before creating a table");
    return `${name} (${this.columns.map((column) => column.definition).join(", ")}, "loaded_at" TEXT NOT NULL${canonical("timestamp", '"loaded_at"')}) STRICT`;
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
  // The writer lock spans all commits and keeps a competing load out; each
  // stream's commit is its own short transaction, so no transaction stays
  // open while the sources read.
  async load() {
    const resources = new DisposableStack();
    let database;
    try {
      resources.use(lockWriter(this.path));
      database = resources.use(new DatabaseSync8(this.path, { timeout: 3e4 }));
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

// packages/destinations/sqlite/dist/sqlite-passes.js
import { existsSync as existsSync2 } from "node:fs";
import { DatabaseSync as DatabaseSync9 } from "node:sqlite";
var busyTimeout = 3e4;
function readSQLite(path) {
  if (existsSync2(path)) {
    var _stack = [];
    try {
      const recovery = __using(_stack, new DatabaseSync9(path, { timeout: busyTimeout }));
      recovery.prepare("SELECT count(*) FROM sqlite_schema").get();
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  return new DatabaseSync9(path, { readOnly: true, timeout: busyTimeout });
}
var SQLitePasses = class {
  #path;
  #pass;
  constructor(path) {
    this.#path = path;
    this.#pass = new Mutex(new SqliteStore(`${path}.locks`)).key("pass", {
      mode: Modes.skipIfBusy()
    });
  }
  // Runs work as the file's one pass, or not at all while another holds it.
  run(work) {
    return this.#pass.run(work);
  }
  // Whether a process runs a pass of the file now.
  running() {
    return this.#pass.isHeld();
  }
  // The latest pass and each stream's latest outcome; null and empty until
  // the file's sync history recorded a pass.
  async status() {
    var _stack = [];
    try {
      if (!existsSync2(this.#path))
        return { pass: null, streams: [] };
      const running = await this.running();
      const data = __using(_stack, readSQLite(this.#path));
      const installed = data.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'view' AND name = 'sync_status'").get();
      if (installed === void 0)
        return { pass: null, streams: [] };
      const state = (status2) => {
        const recorded2 = passState(status2);
        return recorded2 === "running" && !running ? "interrupted" : recorded2;
      };
      const latest = data.prepare("SELECT status, started_at, completed_at, error, last_successful_sync_at FROM sync_status").get();
      return {
        pass: latest === void 0 ? null : recorded(latest, state(latest.status)),
        streams: data.prepare("SELECT stream, status, last_successful_sync_at FROM stream_status ORDER BY stream").all().map((row) => ({
          stream: String(row.stream),
          state: state(row.status),
          lastSucceededAt: text2(row.last_successful_sync_at)
        }))
      };
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
};
function recorded(row, state) {
  const started = {
    startedAt: String(row.started_at),
    lastSucceededAt: text2(row.last_successful_sync_at)
  };
  switch (state) {
    case "running":
    case "interrupted":
      return { ...started, state, completedAt: null, error: null };
    case "succeeded":
      return {
        ...started,
        state,
        completedAt: String(row.completed_at),
        error: null
      };
    default:
      return {
        ...started,
        state,
        completedAt: String(row.completed_at),
        error: String(row.error)
      };
  }
}
function passState(status2) {
  switch (status2) {
    case "running":
    case "succeeded":
    case "partial":
    case "failed":
    case "cancelled":
      return status2;
    default:
      throw new TypeError(`Unknown pass status ${String(status2)}`);
  }
}
function text2(value) {
  if (value === void 0)
    throw new TypeError("A sync history view lacks a column it declares");
  return value === null ? null : String(value);
}

// packages/destinations/sqlite/dist/sqlite-sync-history.js
import { DatabaseSync as DatabaseSync10 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-sync-history-schema.js
var attempts = '"_elt_sync_attempts"';
var coverage = '"_elt_extraction_coverage"';
var now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
var status = `"status" TEXT NOT NULL DEFAULT 'running' CHECK ("status" IN ('running', 'succeeded', 'partial', 'failed', 'cancelled'))`;
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
var busyTimeout2 = 3e4;
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
      const attempt = database.prepare(`INSERT INTO ${attempts} ("connector", "source", "started_at") VALUES (?, ?, ${now}) RETURNING "id"`).get(connection.name, connection.source.identity);
      if (attempt === void 0)
        throw new Error("Sync attempt was not recorded");
      const id2 = Number(attempt.id);
      const declare = database.prepare(`INSERT INTO ${coverage} ("attempt_id", "stream", "target_schema", "target_table", "sync_mode", "destination_sync_mode", "description", "selection") VALUES (?, ?, 'main', ?, ?, ?, ?, ?)`);
      for (const { copy, coverage: coverage2 } of copies)
        declare.run(id2, copy.from.name, copy.to.name, copy.configuration.syncMode, copy.configuration.destinationSyncMode, coverage2.description, JSON.stringify(coverage2.selection));
      return id2;
    });
    return {
      finish: async (outcomes) => this.#finish(path, id, outcomes),
      fail: async (error) => write(path, (database) => {
        database.prepare(`UPDATE ${coverage} SET "status" = 'failed', "failures" = ? WHERE "attempt_id" = ?`).run(JSON.stringify([{ partition: null, error: message(error) }]), id);
        database.prepare(`UPDATE ${attempts} SET "status" = 'failed', "completed_at" = ${now}, "error" = ? WHERE "id" = ?`).run(message(error), id);
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
          error: message(error)
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
    const database = __using(_stack, new DatabaseSync10(path, { timeout: busyTimeout2 }));
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
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// packages/settings/dist/settings.js
import { chmodSync as chmodSync2, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join as join5 } from "node:path";
import { DatabaseSync as DatabaseSync11 } from "node:sqlite";

// packages/settings/dist/selection.js
var named = { accountIds: "account", collectionIds: "collection" };
function selectionProblems(selections, facts) {
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { connector, scope } of selections) {
    if (seen.has(connector))
      problems.push(`${connector}: choose each connector once`);
    seen.add(connector);
    const traits = facts(connector);
    for (const kind of ["accountIds", "collectionIds"]) {
      const ids = scope[kind];
      if (ids === void 0)
        continue;
      if (!traits.narrowsBy(kind))
        problems.push(`${connector}: cannot be narrowed by ${named[kind]} IDs`);
      if (ids.length === 0)
        problems.push(`${connector}: choose at least one ${named[kind]}`);
      if (new Set(ids).size !== ids.length)
        problems.push(`${connector}: choose each ${named[kind]} once`);
    }
    if (traits.datedBy === null && (scope.startAt !== void 0 || scope.endAt !== void 0))
      problems.push(`${connector}: date filtering is unavailable`);
    if (scope.startAt !== void 0 && scope.endAt !== void 0 && scope.startAt >= scope.endAt)
      problems.push(`${connector}: start must precede end`);
  }
  return problems;
}

// packages/settings/dist/store-layout.js
import { createHash as createHash4 } from "node:crypto";
import { join as join4 } from "node:path";
var storeLayout = 4;
var NewerLayoutError = class extends Error {
  constructor() {
    super("A newer version wrote this store; use that version.");
  }
};
function importDirectory(root, selection) {
  const key = createHash4("sha256").update(JSON.stringify([
    storeLayout,
    selection.scope,
    selection.includeAttachments
  ])).digest("hex").slice(0, 16);
  return join4(root, selection.connector, key);
}

// packages/settings/dist/settings.js
var writerWaitMs = 3e4;
var heartbeatMs = 1e3;
var ConnectorRemovedError = class extends Error {
  name = "ConnectorRemovedError";
  constructor(connector) {
    super(`${connector} was removed from the selection`);
  }
};
var selectedConnectors = {
  name: "selected_connectors",
  description: "The connectors the user chose to import, in the order chosen. A connector missing here is not imported. Each import is its own SQLite file: open database to read its records, catalog and sync_status.",
  columns: {
    connector: "Connector name, such as mail, notes or messages.",
    scope: "JSON of the chosen accounts (accountIds), collections (collectionIds) and dates (startAt inclusive, endAt exclusive); an absent key means all.",
    include_attachments: "1 when attachment bytes are copied beside the records, 0 for metadata only.",
    database: "Path of the SQLite file the import loads. It may not exist yet while the first import starts.",
    connection_error: "Why the import could not start, such as missing macOS access; NULL when it started. A connector with an error is inaccessible, not empty.",
    connection_failed_at: "When the import last failed to start, as an ISO 8601 UTC timestamp; NULL when it started.",
    permissions: "What the user can do in macOS to give access to this app."
  },
  query: `SELECT s."connector", s."scope", s."include_attachments", s."directory" || '/data.sqlite' AS "database",
      f."error" AS "connection_error", f."failed_at" AS "connection_failed_at", s."permissions"
    FROM "selections" s LEFT JOIN "connection_failures" f ON f."directory" = s."directory"
    ORDER BY s."position"`
};
var Settings = class {
  root;
  settings;
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 448 });
    chmodSync2(root, 448);
    const path = this.#path;
    this.settings = new DatabaseSync11(path, { timeout: writerWaitMs });
    try {
      chmodSync2(path, 384);
      if (this.layout() !== storeLayout)
        this.rebuild();
      this.settings.exec("CREATE TABLE IF NOT EXISTS selections (position INTEGER PRIMARY KEY, connector TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, include_attachments INTEGER NOT NULL, directory TEXT NOT NULL, permissions TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failed_at TEXT NOT NULL);");
    } catch (error) {
      this.settings.close();
      throw error;
    }
  }
  get #path() {
    return join5(this.root, "settings.sqlite");
  }
  layout() {
    return Number(this.settings.prepare("PRAGMA user_version").get()?.user_version);
  }
  // Refuses a file a newer layout wrote, and empties one an older layout
  // wrote: stored settings are disposable, so the user sets up again.
  rebuild() {
    this.settings.exec("BEGIN IMMEDIATE");
    try {
      const layout = this.layout();
      if (layout > storeLayout)
        throw new NewerLayoutError();
      if (layout < storeLayout) {
        for (const { type, name } of this.settings.prepare("SELECT type, name FROM sqlite_schema WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table'").all())
          this.settings.exec(`DROP ${type === "view" ? "VIEW" : "TABLE"} IF EXISTS "${String(name).replaceAll('"', '""')}"`);
        this.settings.exec(`PRAGMA user_version = ${storeLayout}`);
      }
      this.settings.exec("COMMIT");
    } catch (error) {
      this.settings.exec("ROLLBACK");
      throw error;
    }
  }
  selections() {
    return this.settings.prepare("SELECT connector, scope, include_attachments FROM selections ORDER BY position").all().map((row) => ({
      connector: String(row.connector),
      scope: JSON.parse(String(row.scope)),
      includeAttachments: row.include_attachments === 1
    }));
  }
  // Saves a selection that has no problems, with what macOS needs granted for
  // each connector, forgets the failures of every other import, removes those
  // imports and publishes what readers see.
  async select(selections, { facts, permissions }) {
    const problems = selectionProblems(selections, facts);
    if (problems.length > 0)
      throw new Error(problems.join("\n"));
    this.settings.exec("BEGIN IMMEDIATE");
    try {
      this.settings.exec("DELETE FROM selections");
      const insert = this.settings.prepare("INSERT INTO selections VALUES(?,?,?,?,?,?)");
      for (const [position, selection] of selections.entries())
        insert.run(position, selection.connector, JSON.stringify(selection.scope), selection.includeAttachments ? 1 : 0, this.directory(selection), permissions(selection));
      this.settings.exec("DELETE FROM connection_failures WHERE directory NOT IN (SELECT directory FROM selections)");
      this.settings.exec("COMMIT");
    } catch (error) {
      this.settings.exec("ROLLBACK");
      throw error;
    }
    await this.removeStaleImports();
    this.publish();
  }
  // Removes every import directory but the selected one of each connector,
  // including those of connectors no longer selected. One a pass still runs
  // is left to that pass, which removes it once its removal stops it.
  async removeStaleImports() {
    const kept = new Set(this.selections().map((selection) => this.directory(selection)));
    for (const connector of readdirSync(this.root, { withFileTypes: true }))
      if (connector.isDirectory())
        for (const entry of readdirSync(join5(this.root, connector.name))) {
          const directory = join5(this.root, connector.name, entry);
          if (!kept.has(directory) && !await new SQLitePasses(join5(directory, "data.sqlite")).running())
            rmSync(directory, { recursive: true, force: true });
        }
  }
  // Aborts with ConnectorRemovedError once the selection no longer names this
  // import. It reads the settings again only when PRAGMA data_version says
  // another connection committed.
  removal(selection) {
    const directory = this.directory(selection);
    const watcher = new DatabaseSync11(this.#path, {
      readOnly: true,
      timeout: writerWaitMs
    });
    const version = watcher.prepare("PRAGMA data_version");
    const selected = watcher.prepare("SELECT 1 FROM selections WHERE directory = ?");
    const controller = new AbortController();
    let seen;
    const check = () => {
      try {
        const current = version.get()?.data_version;
        if (current === seen)
          return;
        seen = current;
        if (selected.get(directory) === void 0)
          controller.abort(new ConnectorRemovedError(selection.connector));
      } catch (error) {
        controller.abort(error);
      }
    };
    check();
    const heartbeat = setInterval(check, heartbeatMs);
    const stop = () => {
      clearInterval(heartbeat);
      if (watcher.isOpen)
        watcher.close();
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    return { signal: controller.signal, [Symbol.dispose]: stop };
  }
  // Publishes selected_connectors and the catalog listing it; safe to repeat.
  publish() {
    publishSQLiteViews(this.settings, { views: [selectedConnectors] });
    installSQLiteCatalog({ path: this.#path });
  }
  directory(selection) {
    return importDirectory(this.root, selection);
  }
  database(selection) {
    return join5(this.directory(selection), "data.sqlite");
  }
  connectionFailure(selection) {
    const row = this.settings.prepare("SELECT error, failed_at FROM connection_failures WHERE directory=?").get(this.directory(selection));
    return row === void 0 ? void 0 : { error: String(row.error), failedAt: String(row.failed_at) };
  }
  saveConnectionFailure(selection, error) {
    this.settings.prepare("INSERT INTO connection_failures VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(directory) DO UPDATE SET error=excluded.error, failed_at=excluded.failed_at").run(this.directory(selection), error);
  }
  clearConnectionFailure(selection) {
    this.settings.prepare("DELETE FROM connection_failures WHERE directory=?").run(this.directory(selection));
  }
  [Symbol.dispose]() {
    this.settings.close();
  }
};

// packages/connectors/apple/connector/dist/apple-connector.js
var AppleConnector = class {
  name;
  title;
  // Where the connector keeps its presets, beside its manifest; it may not
  // exist.
  presetsFolder;
  // What to know before narrowing this connector, such as how the app's
  // collections nest.
  note;
  // For a connector with no choices: a stream read only to show the app's store
  // opens.
  probe;
  host;
  constructor(host, identity) {
    this.host = host;
    this.name = identity.name;
    this.title = identity.title;
    this.presetsFolder = join6(identity.folder, "presets");
  }
  // Read when asked, so a preset added to a user connector's folder is offered
  // without a restart.
  presets() {
    if (!existsSync3(this.presetsFolder))
      return [];
    return readdirSync2(this.presetsFolder).filter((file) => file.endsWith(".sql")).sort().map((file) => ({
      name: file.slice(0, -".sql".length),
      file: join6(this.presetsFolder, file)
    }));
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
  // What a selection of this connector covers, in a person's words.
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
  // The connector's title and what a selection of it covers, as one phrase.
  titled(scope) {
    const covers = this.describe(scope);
    return covers === "everything" ? this.title : `${this.title} (${covers})`;
  }
  // The reader view of a stream: raw_inlineAttachments reads as
  // inline_attachments.
  view(stream) {
    return stream.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }
  // The rows of the streams this connector can be narrowed by. Opening the
  // app's store is also what makes macOS ask for access, so a denial fails
  // here, before anything is selected.
  async choiceRows() {
    const source = this.source(this.defaultScope());
    const catalog = await source.discover();
    const streams = this.probe === void 0 ? this.choices.map(({ stream }) => stream) : [this.probe];
    const rows = /* @__PURE__ */ new Map();
    for await (const message2 of source.read(streams.map((stream) => new CopyConfiguration(catalog.get(stream), {
      syncMode: "full_refresh",
      destinationSyncMode: "overwrite"
    })), /* @__PURE__ */ new Map())) {
      if (message2 instanceof StreamStatus) {
        if (message2.status === "FAILED")
          throw message2.error;
        continue;
      }
      if (!("type" in message2) && message2.stream !== this.probe)
        rows.set(message2.stream, [
          ...rows.get(message2.stream) ?? [],
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every Apple source validates its records against the stream's object schema
          message2.data
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
  // One pass of this connector's import, as every host runs it: one pass of an
  // import at a time, stopped once the user removes the connector, its
  // connection failure kept in the settings and its outcome in the import's
  // sync history.
  async import(settings, selection, history) {
    var _stack = [];
    try {
      const removal = __using(_stack, settings.removal(selection));
      try {
        const pass = await new SQLitePasses(settings.database(selection)).run(async () => {
          let built;
          try {
            built = await this.connection(settings.directory(selection), selection);
          } catch (error) {
            settings.saveConnectionFailure(selection, error instanceof Error ? error.message : String(error));
            return { status: "unconnected", error };
          }
          settings.clearConnectionFailure(selection);
          const { connection, destination } = built;
          await history.install([destination]);
          installSQLiteCatalog(destination);
          await new Pipeline({ connections: [connection], history }).run({ signal: removal.signal }).catch((error) => {
            if (!(error instanceof PipelineError))
              throw error;
          });
          return { status: "imported" };
        });
        return pass.acquired ? pass.value : { status: "busy" };
      } catch (error) {
        if (!(error instanceof ConnectorRemovedError))
          throw error;
        await settings.removeStaleImports();
        return { status: "removed" };
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  // The connector's streams, loaded incrementally into raw_<stream> tables of
  // the import directory's data.sqlite and read through documented views, with
  // checkpoints.sqlite and attachment copies in files/ beside it.
  async connection(directory, selection) {
    const { scope, includeAttachments } = selection;
    const source = await this.importSource(scope);
    const narrowed = Object.keys(scope).length > 0;
    const { streams } = await source.discover();
    const withFiles = (stream) => includeAttachments && stream.supportsFileTransfer === true && !this.storeCopies.includes(stream.name);
    mkdirSync2(directory, { recursive: true, mode: 448 });
    const destination = new SQLiteDestination({
      path: join6(directory, "data.sqlite")
    });
    const files = new LocalFiles({ directory: join6(directory, "files") });
    const connection = new Connection({
      name: this.name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join6(directory, "checkpoints.sqlite")
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
  SQLitePasses,
  SQLiteSyncHistory,
  NewerLayoutError,
  Settings,
  AppleConnector
};
