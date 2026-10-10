import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// packages/sdks/apple/app-database/dist/app-database.js
import { DatabaseSync } from "node:sqlite";
var unavailableCodes = /* @__PURE__ */ new Set([14, 23]);
function open(path, unavailable) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (cause instanceof Error && "errcode" in cause && unavailableCodes.has(Number(cause.errcode)))
      throw new unavailable(path, cause);
    throw cause;
  }
}
var AppDatabase = class {
  path;
  #database;
  constructor(path, unavailable) {
    this.path = path;
    this.#database = open(path, unavailable);
    try {
      this.#database.exec("BEGIN");
      this.#database.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
    } catch (cause) {
      this.#database.close();
      throw cause;
    }
  }
  // Refuses a layout without these columns, and closes the database: the
  // check a reader makes while it opens the snapshot.
  requireColumns(columns, schema) {
    const missing = this.missingColumns(columns);
    if (missing.length === 0)
      return;
    this[Symbol.dispose]();
    throw new schema(this.path, missing);
  }
  // The columns, as table.column, that this layout lacks. A reader whose
  // reads use different tables checks each read with it and keeps the
  // snapshot open for the others.
  missingColumns(columns) {
    return Object.entries(columns).flatMap(([table, names]) => {
      const present = new Set(this.all("SELECT name FROM pragma_table_info(?)", table).map((column) => column.name));
      return names.filter((name) => !present.has(name)).map((name) => `${table}.${name}`);
    });
  }
  all(sql, ...parameters) {
    return this.#database.prepare(sql).all(...parameters);
  }
  // Rows one at a time, for a table too large to hold whole.
  iterate(sql, ...parameters) {
    return this.#database.prepare(sql).iterate(...parameters);
  }
  [Symbol.dispose]() {
    if (!this.#database.isOpen)
      return;
    if (this.#database.isTransaction)
      this.#database.exec("COMMIT");
    this.#database.close();
  }
};
var AppDatabaseVersion = class {
  #database;
  #version;
  constructor(path, unavailable) {
    this.#database = open(path, unavailable);
    this.#version = this.#database.prepare("PRAGMA data_version");
  }
  get current() {
    return Number(this.#version.get()?.data_version);
  }
  [Symbol.dispose]() {
    this.#database.close();
  }
};

// packages/sdks/apple/app-database/dist/reference-date.js
function referenceDateInstant(seconds) {
  const micros = Math.round(seconds * 1e6);
  const whole = Math.floor(micros / 1e6);
  const iso = new Date((whole + 978307200) * 1e3).toISOString();
  return `${iso.slice(0, 19)}.${String(micros - whole * 1e6).padStart(6, "0")}Z`;
}

export {
  AppDatabase,
  AppDatabaseVersion,
  referenceDateInstant
};
