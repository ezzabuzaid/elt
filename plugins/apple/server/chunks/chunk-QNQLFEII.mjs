import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  installSQLiteCatalog,
  publishSQLiteViews
} from "./chunk-YZBCNEVG.mjs";
import {
  Connection,
  Copy,
  CopyConfiguration,
  LocalFiles,
  Pipeline,
  PipelineError,
  StreamStatus
} from "./chunk-2UKXR4JG.mjs";
import {
  __callDispose,
  __using
} from "./chunk-ZGXE7NZW.mjs";

// packages/connectors/apple/connector/dist/apple-connector.js
import { existsSync, mkdirSync as mkdirSync2, readdirSync as readdirSync2 } from "node:fs";
import { join as join3 } from "node:path";

// packages/settings/dist/settings.js
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join as join2 } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
import { createHash } from "node:crypto";
import { join } from "node:path";
var storeLayout = 7;
var NewerLayoutError = class extends Error {
  constructor() {
    super("A newer version wrote this store; use that version.");
  }
};
function importDirectory(root, selection) {
  const key = createHash("sha256").update(JSON.stringify([
    storeLayout,
    selection.scope,
    selection.includeAttachments
  ])).digest("hex").slice(0, 16);
  return join(root, selection.connector, key);
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
    connection_failure_type: "config when the user can fix connection_error by giving access or changing what they set up, and permissions says how; system for any other reason; NULL when the import started.",
    connection_failed_at: "When the import last failed to start, as an ISO 8601 UTC timestamp; NULL when it started.",
    permissions: "What the user can do in macOS to give access to this app."
  },
  query: `SELECT s."connector", s."scope", s."include_attachments", s."directory" || '/data.sqlite' AS "database",
      f."error" AS "connection_error", f."failure_type" AS "connection_failure_type", f."failed_at" AS "connection_failed_at", s."permissions"
    FROM "selections" s LEFT JOIN "connection_failures" f ON f."directory" = s."directory"
    ORDER BY s."position"`
};
var Settings = class {
  root;
  settings;
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 448 });
    chmodSync(root, 448);
    const path = this.#path;
    this.settings = new DatabaseSync(path, { timeout: writerWaitMs });
    try {
      chmodSync(path, 384);
      if (this.layout() !== storeLayout)
        this.rebuild();
      this.settings.exec(`CREATE TABLE IF NOT EXISTS selections (position INTEGER PRIMARY KEY, connector TEXT NOT NULL UNIQUE, scope TEXT NOT NULL, include_attachments INTEGER NOT NULL, directory TEXT NOT NULL, permissions TEXT NOT NULL); CREATE TABLE IF NOT EXISTS connection_failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failure_type TEXT NOT NULL CHECK (failure_type IN ('config', 'system')), failed_at TEXT NOT NULL);`);
    } catch (error) {
      this.settings.close();
      throw error;
    }
  }
  get #path() {
    return join2(this.root, "settings.sqlite");
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
  // each connector, forgets the failures of every other import and publishes
  // what readers see. The imports it no longer names are left stale.
  select(selections, { facts, permissions }) {
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
    this.publish();
  }
  // Every import directory but the selected one of each connector, including
  // those of connectors no longer selected. A host removes each once no pass
  // runs it, since a pass keeps its locks inside.
  staleImports() {
    const kept = new Set(this.selections().map((selection) => this.directory(selection)));
    return readdirSync(this.root, { withFileTypes: true }).filter((connector) => connector.isDirectory()).flatMap((connector) => readdirSync(join2(this.root, connector.name)).map((entry) => join2(this.root, connector.name, entry))).filter((directory) => !kept.has(directory));
  }
  // Aborts with ConnectorRemovedError once the selection no longer names this
  // import. It reads the settings again only when PRAGMA data_version says
  // another connection committed.
  removal(selection) {
    const directory = this.directory(selection);
    const watcher = new DatabaseSync(this.#path, {
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
    return join2(this.directory(selection), "data.sqlite");
  }
  connectionFailure(selection) {
    const row = this.settings.prepare("SELECT error, failure_type, failed_at FROM connection_failures WHERE directory=?").get(this.directory(selection));
    return row === void 0 ? void 0 : {
      error: String(row.error),
      failedAt: String(row.failed_at),
      failureType: row.failure_type === "config" ? "config" : "system"
    };
  }
  saveConnectionFailure(selection, error, failureType) {
    this.settings.prepare("INSERT INTO connection_failures (directory, error, failure_type, failed_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(directory) DO UPDATE SET error=excluded.error, failure_type=excluded.failure_type, failed_at=excluded.failed_at").run(this.directory(selection), error, failureType);
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
    this.presetsFolder = join3(identity.folder, "presets");
  }
  // Read when asked, so a preset added to a user connector's folder is offered
  // without a restart.
  presets() {
    if (!existsSync(this.presetsFolder))
      return [];
    return readdirSync2(this.presetsFolder).filter((file) => file.endsWith(".sql")).sort().map((file) => ({
      name: file.slice(0, -".sql".length),
      file: join3(this.presetsFolder, file)
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
  // Whose an error is to fix, as this connector's source classifies it.
  failureType(error) {
    return this.source(this.defaultScope()).failureType(error);
  }
  // What failed, and, when it is the user's to fix, what macOS access the app
  // needs. A failure the history or settings kept passes the type they
  // stored; null, for a stopped pass, has nothing for the user to fix.
  failure(error, failureType = this.failureType(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return failureType === "config" ? `${message} \u2014 ${this.guidance()}` : message;
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
      ...scope.startAt ? [`from ${localDay(Date.parse(scope.startAt))}`] : [],
      // endAt is exclusive: the last day covered is the one before it.
      ...scope.endAt ? [`until ${localDay(Date.parse(scope.endAt) - 1)}`] : []
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
    for await (const message of source.read(streams.map((stream) => new CopyConfiguration(catalog.get(stream), {
      syncMode: "full_refresh",
      destinationSyncMode: "overwrite"
    })), /* @__PURE__ */ new Map())) {
      if (message instanceof StreamStatus) {
        if (message.status === "FAILED")
          throw message.error;
        continue;
      }
      if (!("type" in message) && message.stream !== this.probe)
        rows.set(message.stream, [
          ...rows.get(message.stream) ?? [],
          // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- every Apple source validates its records against the stream's object schema
          message.data
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
  // One pass of this connector's import, as every host runs it inside the
  // import's flight: stopped once the user removes the connector, its
  // connection failure kept in the settings and its outcome in the import's
  // sync history.
  async import(settings, selection, history) {
    var _stack = [];
    try {
      const removal = __using(_stack, settings.removal(selection));
      let built;
      try {
        built = await this.connection(settings.directory(selection), selection);
      } catch (error) {
        settings.saveConnectionFailure(selection, error instanceof Error ? error.message : String(error), this.failureType(error));
        return { status: "unconnected", error };
      }
      settings.clearConnectionFailure(selection);
      const { connection, destination } = built;
      await history.install([destination]);
      installSQLiteCatalog(destination);
      try {
        await new Pipeline({ connections: [connection], history }).run({
          signal: removal.signal
        });
      } catch (error) {
        if (error instanceof ConnectorRemovedError)
          return { status: "removed" };
        if (!(error instanceof PipelineError))
          throw error;
      }
      return { status: "imported" };
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
      path: join3(directory, "data.sqlite")
    });
    const files = new LocalFiles({ directory: join3(directory, "files") });
    const connection = new Connection({
      name: this.name,
      source,
      destination,
      checkpoints: new SQLiteCheckpointStore({
        path: join3(directory, "checkpoints.sqlite")
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
function localDay(epochMilliseconds) {
  const instant = new Date(epochMilliseconds);
  const pad = (part) => String(part).padStart(2, "0");
  return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}`;
}

export {
  NewerLayoutError,
  Settings,
  AppleConnector
};
