import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  CheckpointStore,
  Connection,
  Copy,
  CopyConfiguration,
  Destination,
  FileContent,
  FileRead,
  LocalFiles,
  StreamStatus,
  SyncHistory,
  Target,
  TargetMissingError,
  TargetOwnedError,
  Writer,
  copyStatus,
  describeTarget,
  isCalendarDate,
  isTimestamp,
  passError,
  passStatus,
  readerCatalog,
  syncHistoryRelations,
  undescribed
} from "./chunk-OEQ4WCEQ.mjs";
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// packages/connectors/apple/app/dist/apple-app.js
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
import { resolve } from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var SQLiteCheckpointStore = class extends CheckpointStore {
  path;
  constructor({ path }) {
    super();
    if (!path || path === ":memory:" || path.includes("\0"))
      throw new TypeError("Checkpoints require a persistent SQLite file");
    this.path = resolve(path);
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
function canonical(kind, name) {
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
    const check = this.array ? ` CHECK (json_valid(${this.quotedName}) AND json_type(${this.quotedName}) = 'array')` : canonical(this.kind, this.quotedName);
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
import { resolve as resolve2 } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";

// packages/destinations/sqlite/dist/sqlite-writer.js
import { createHash } from "node:crypto";
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
    return createHash("sha256").update(this.table.location).digest("hex");
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
    return `CREATE TABLE IF NOT EXISTS ${this.quotedName} (${this.columns.map((column) => column.definition).join(", ")}, "loaded_at" TEXT NOT NULL${canonical("timestamp", '"loaded_at"')}) STRICT`;
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
    this.path = path === ":memory:" ? path : resolve2(path);
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
      database = resources.use(new DatabaseSync4(this.path, { timeout: 3e4 }));
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
function message(error) {
  return error instanceof Error ? error.message : String(error);
}

// packages/connectors/apple/app/dist/apple-app.js
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
      path: join(directory, "data.sqlite")
    });
    const files = new LocalFiles({ directory: join(directory, "files") });
    const connection = new Connection({
      name: this.name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join(directory, "checkpoints.sqlite")
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
  publishSQLiteViews,
  installSQLiteCatalog,
  SQLiteSyncHistory,
  AppleApp
};
