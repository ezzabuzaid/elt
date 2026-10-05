import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  decodeArchive,
  isBinaryPlist,
  isDictionary,
  parseBinaryPlist,
  readPlist
} from "../../chunks/chunk-YLKLHO7E.mjs";
import {
  selected,
  withinDates
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  byId
} from "../../chunks/chunk-FGFSL4M6.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-W6HR6UKA.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-OEQ4WCEQ.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/safari/dist/apple-safari-source.js
import { readdir, stat } from "node:fs/promises";
import { join as join3 } from "node:path";
import { setInterval } from "node:timers/promises";

// packages/sources/apple/safari/dist/safari-scan.js
import { join as join2 } from "node:path";

// packages/sources/apple/safari/dist/safari-values.js
var defaultProfile = "DefaultProfile";
var appleEpochSeconds = 978307200;
var distantPast = -63114076800;
var distantFuture = 63113904e3;
var appleTime = (value) => typeof value === "number" && Number.isFinite(value) && value > distantPast && value < distantFuture ? new Date(Math.round((value + appleEpochSeconds) * 1e3)).toISOString() : null;
var plistTime = (value) => value instanceof Date && value.getUTCFullYear() > 1 && value.getUTCFullYear() < 4001 ? value.toISOString() : null;
var base64 = (value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : null;
var text = (value) => typeof value === "string" && value !== "" ? value : null;
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
var number = (value) => typeof value === "number" && Number.isFinite(value) ? value : null;
var flag = (value) => value === 1 || value === true;
var dictionary = (value) => isDictionary(value) ? value : {};
var list = (value) => Array.isArray(value) ? value : [];
var strings = (value) => list(value).filter((item) => typeof item === "string");
function counts(value) {
  if (!(value instanceof Uint8Array))
    return null;
  if (value.byteLength % 4 !== 0)
    throw new TypeError("Safari visit counts are not 32-bit integers");
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return Array.from({ length: value.byteLength / 4 }, (_, index) => view.getInt32(index * 4, true));
}

// packages/sources/apple/safari/dist/bookmarks-reader.js
var readingListTitle = "com.apple.ReadingList";
var BookmarksReader = class {
  bookmarks = [];
  readingList = [];
  constructor(plist2) {
    const root = dictionary(plist2);
    if (typeof root.WebBookmarkType !== "string")
      throw new TypeError("Bookmarks.plist has no root folder");
    const walk = (folder2, parentId) => list(folder2.Children).forEach((child, position) => {
      const node = dictionary(child);
      const entry = { node, parentId, position };
      if (folder2.Title === readingListTitle && node.WebBookmarkType === "WebBookmarkTypeLeaf") {
        this.readingList.push(entry);
        return;
      }
      this.bookmarks.push(entry);
      walk(node, String(node.WebBookmarkUUID));
    });
    walk(root, null);
  }
};

// packages/sources/apple/safari/dist/closed-tabs-reader.js
var windowType = 1;
var ClosedTabsReader = class {
  #windows = /* @__PURE__ */ new Map();
  #tabs = /* @__PURE__ */ new Map();
  constructor(plist2, scope) {
    const entries = dictionary(plist2).ClosedTabOrWindowPersistentStates;
    if (!Array.isArray(entries))
      throw new TypeError("RecentlyClosedTabs.plist lists no closed entries");
    entries.forEach((value, position) => {
      const entry = dictionary(value);
      const state = dictionary(entry.PersistentState);
      if (!selected(scope.collectionIds, state.ProfileUUID))
        return;
      if (entry.PersistentStateType !== windowType) {
        latest(this.#tabs, state.TabUUID, {
          state,
          closedWindowId: null,
          position
        });
        return;
      }
      latest(this.#windows, state.WindowUUID, { state, position });
      for (const [index, tab] of list(state.TabStates).entries())
        latest(this.#tabs, dictionary(tab).TabUUID, {
          state: dictionary(tab),
          closedWindowId: state.WindowUUID,
          position: index
        });
    });
  }
  get windows() {
    return [...this.#windows.values()];
  }
  get tabs() {
    return [...this.#tabs.values()];
  }
};
function latest(entries, id2, entry) {
  const kept = entries.get(id2);
  const closed = (candidate) => candidate.state.DateClosed instanceof Date ? candidate.state.DateClosed.getTime() : Number.NEGATIVE_INFINITY;
  if (kept === void 0 || closed(entry) > closed(kept))
    entries.set(id2, entry);
}

// packages/sources/apple/safari/dist/cloud-tabs-reader.js
import { inflateSync } from "node:zlib";
var cloudTabsColumns = {
  cloud_tab_devices: [
    "device_uuid",
    "device_name",
    "device_type_identifier",
    "has_duplicate_device_name",
    "is_ephemeral_device",
    "last_modified"
  ],
  cloud_tabs: [
    "tab_uuid",
    "device_uuid",
    "position",
    "title",
    "url",
    "is_showing_reader",
    "is_pinned",
    "reader_scroll_position_page_index",
    "scene_id",
    "last_viewed_time",
    "topic_title"
  ],
  cloud_tab_close_requests: [
    "close_request_uuid",
    "destination_device_uuid",
    "url",
    "tab_uuid"
  ]
};
var select = (table, order) => `SELECT ${cloudTabsColumns[table].join(", ")} FROM ${table} ORDER BY ${order}`;
var CloudTabsReader = class {
  database;
  #tabs;
  constructor(database) {
    this.database = database;
  }
  get devices() {
    return this.database.all(select("cloud_tab_devices", "device_uuid"));
  }
  get tabs() {
    this.#tabs ??= this.database.all(select("cloud_tabs", "tab_uuid"));
    return this.#tabs;
  }
  get closeRequests() {
    return this.database.all(select("cloud_tab_close_requests", "close_request_uuid"));
  }
  // A tab's position is zlib-compressed JSON: {"sortValues": [...]}.
  positions() {
    return this.tabs.flatMap((tab) => {
      if (!(tab.position instanceof Uint8Array))
        throw new TypeError("A Safari iCloud tab has no position");
      const { sortValues } = JSON.parse(inflateSync(tab.position).toString("utf8"));
      return sortValues.map((entry, index) => ({ tab, entry, index }));
    });
  }
};

// packages/sources/apple/safari/dist/downloads-reader.js
var DownloadsReader = class {
  downloads;
  constructor(plist2, scope) {
    const history = dictionary(plist2).DownloadHistory;
    if (!Array.isArray(history))
      throw new TypeError("Downloads.plist lists no download history");
    this.downloads = list(history).map(dictionary).filter((entry) => selected(scope.collectionIds, entry.DownloadEntryProfileUUIDStringKey));
  }
};

// packages/sources/apple/safari/dist/history-reader.js
var historyColumns = {
  history_items: [
    "id",
    "url",
    "domain_expansion",
    "visit_count",
    "daily_visit_counts",
    "weekly_visit_counts",
    "autocomplete_triggers",
    "should_recompute_derived_visit_counts",
    "visit_count_score",
    "status_code"
  ],
  history_visits: [
    "id",
    "history_item",
    "visit_time",
    "title",
    "load_successful",
    "http_non_get",
    "synthesized",
    "redirect_source",
    "redirect_destination",
    "origin",
    "generation",
    "attributes",
    "score"
  ],
  history_tombstones: [
    "id",
    "start_time",
    "end_time",
    "url",
    "generation",
    "udid",
    "attributes"
  ],
  history_tags: [
    "id",
    "type",
    "level",
    "identifier",
    "title",
    "modification_timestamp",
    "item_count"
  ],
  history_items_to_tags: ["history_item", "tag_id", "timestamp"]
};
var select2 = (table, order) => `SELECT ${historyColumns[table].join(", ")} FROM ${table} ORDER BY ${order}`;
var HistoryReader = class {
  database;
  profileId;
  scope;
  #visits;
  #items;
  #itemTags;
  #tags;
  constructor(database, profileId5, scope) {
    this.database = database;
    this.profileId = profileId5;
    this.scope = scope;
  }
  get #included() {
    return selected(this.scope.collectionIds, this.profileId);
  }
  #all(sql) {
    return this.database.all(sql).map((row) => ({ ...row, $profile: this.profileId }));
  }
  get #dated() {
    return this.scope.startAt !== void 0 || this.scope.endAt !== void 0;
  }
  get visits() {
    this.#visits ??= this.#included ? this.#all(select2("history_visits", "id")).filter((row) => withinDates(this.scope, appleTime(row.visit_time))) : [];
    return this.#visits;
  }
  get items() {
    if (this.#items !== void 0)
      return this.#items;
    const visited = new Set(this.visits.map((visit) => visit.history_item));
    this.#items = this.#included ? this.#all(select2("history_items", "id")).filter((row) => !this.#dated || visited.has(row.id)) : [];
    return this.#items;
  }
  get itemTags() {
    if (this.#itemTags !== void 0)
      return this.#itemTags;
    const items = new Set(this.items.map((item) => item.id));
    this.#itemTags = this.#included ? this.#all(select2("history_items_to_tags", "history_item, tag_id")).filter((row) => items.has(row.history_item)) : [];
    return this.#itemTags;
  }
  get tags() {
    if (this.#tags !== void 0)
      return this.#tags;
    const linked = new Set(this.itemTags.map((link) => link.tag_id));
    this.#tags = this.#included ? this.#all(select2("history_tags", "id")).filter((row) => !this.#dated || linked.has(row.id)) : [];
    return this.#tags;
  }
  // Tombstones record deletions to sync to other devices, whatever their date.
  get tombstones() {
    return this.#included ? this.#all(select2("history_tombstones", "id")) : [];
  }
};
var triggers = (value) => value instanceof Uint8Array ? parseBinaryPlist(value) : null;

// packages/sources/apple/safari/dist/safari-store.js
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var safariDirectory = join(homedir(), "Library/Safari");
var safariContainer = join(homedir(), "Library/Containers/com.apple.Safari/Data/Library/Safari");
var SafariUnavailableError = class extends Error {
  name = "SafariUnavailableError";
  constructor(path, cause) {
    super(`Safari data at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Safari does not need to be open.`, { cause });
  }
};
var SafariSchemaError = class extends Error {
  name = "SafariSchemaError";
  constructor(path, missing) {
    super(`The Safari store at ${path} has a layout this connector does not read (missing ${missing.join(", ")}).`);
  }
};
var unavailableCodes = /* @__PURE__ */ new Set([14, 23]);
var open = (path) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (cause instanceof Error && "errcode" in cause && unavailableCodes.has(Number(cause.errcode)))
      throw new SafariUnavailableError(path, cause);
    throw cause;
  }
};
var SafariDatabaseVersion = class {
  #database;
  #version;
  constructor(path) {
    this.#database = open(path);
    this.#version = this.#database.prepare("PRAGMA data_version");
  }
  get current() {
    return Number(this.#version.get()?.data_version);
  }
  [Symbol.dispose]() {
    this.#database.close();
  }
};
var SafariDatabase = class _SafariDatabase {
  path;
  #database;
  constructor(path, database) {
    this.path = path;
    this.#database = database;
  }
  static async open(path, required) {
    const database = open(path);
    try {
      database.exec("BEGIN");
      const missing = Object.entries(required).flatMap(([table, columns]) => {
        const present = new Set(database.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((column) => column.name));
        return columns.filter((column) => !present.has(column)).map((column) => `${table}.${column}`);
      });
      if (missing.length > 0)
        throw new SafariSchemaError(path, missing);
      return new _SafariDatabase(path, database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }
  all(sql) {
    return this.#database.prepare(sql).all();
  }
  async [Symbol.asyncDispose]() {
    if (this.#database.isTransaction)
      this.#database.exec("COMMIT");
    this.#database.close();
  }
};
async function readSafariPlist(path) {
  let bytes;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    throw new SafariUnavailableError(path, cause);
  }
  return isBinaryPlist(bytes) ? parseBinaryPlist(bytes) : readPlist(path);
}

// packages/sources/apple/safari/dist/tabs-reader.js
var tabsColumns = {
  bookmarks: [
    "id",
    "parent",
    "type",
    "subtype",
    "special_id",
    "hidden",
    "title",
    "url",
    "order_index",
    "external_uuid",
    "server_id",
    "last_modified",
    "date_closed",
    "last_selected_child",
    "extra_attributes",
    "local_attributes",
    "topic_title"
  ],
  windows: [
    "id",
    "uuid",
    "active_tab_group_id",
    "active_profile_id",
    "local_tab_group_id",
    "private_tab_group_id",
    "is_last_session",
    "date_closed",
    "scene_id",
    "extra_attributes"
  ],
  windows_tab_groups: ["window_id", "tab_group_id", "active_tab_id"],
  windows_profiles: ["window_id", "profile_id", "active_tab_group_id"],
  windows_unnamed_tab_groups: ["window_id", "tab_group_id"],
  settings: ["key", "value", "parent"]
};
var select3 = (table, order) => `SELECT ${tabsColumns[table].join(", ")} FROM ${table} ORDER BY ${order}`;
var folder = 1;
var profileSubtype = 2;
var favoritesSubtype = 1;
var deviceSubtype = 3;
var rootId = 0;
var namedSpecials = new Map(["pinned", "privatePinned", "recentlyClosed"].map((kind) => [
  kind,
  kind
]));
var tabGroupKinds = [
  "named",
  "unnamed",
  "local",
  "private",
  "pinned",
  "privatePinned",
  "recentlyClosed",
  "favorites",
  "device",
  "special"
];
var TabsReader = class {
  database;
  scope;
  #rows;
  #byId;
  #windows;
  #attributes = /* @__PURE__ */ new Map();
  constructor(database, scope) {
    this.database = database;
    this.scope = scope;
    this.#rows = database.all(select3("bookmarks", "id"));
    this.#byId = new Map(this.#rows.map((row) => [row.id, row]));
    this.#windows = database.all(select3("windows", "id"));
  }
  // Every profile, and where its History.db lives: the default profile's is
  // ~/Library/Safari, another's the Profiles folder named by its server_id.
  get allProfiles() {
    return this.#rows.filter((row) => row.type === folder && row.subtype === profileSubtype);
  }
  get profiles() {
    return this.allProfiles.filter((row) => selected(this.scope.collectionIds, row.external_uuid));
  }
  get windows() {
    return this.#windows.filter((window) => selected(this.scope.collectionIds, this.uuid(window.active_profile_id)));
  }
  // Folders of no profile, such as pinned tabs, are shared by every profile,
  // so any profile's scope keeps them.
  get tabGroups() {
    return this.#rows.filter((row) => row.type === folder && row.id !== rootId && row.subtype !== profileSubtype && (this.profileOf(row) === null || this.#included(row)));
  }
  get tabs() {
    return this.#rows.filter((row) => row.type !== folder && this.#included(row));
  }
  get windowTabGroups() {
    const windows = new Set(this.windows.map((window) => window.id));
    const unnamed = this.database.all(select3("windows_unnamed_tab_groups", "window_id, tab_group_id")).filter((row) => windows.has(row.window_id));
    const active = this.database.all(select3("windows_tab_groups", "window_id, tab_group_id")).filter((row) => windows.has(row.window_id));
    const key = (row) => `${row.window_id}:${row.tab_group_id}`;
    const pairs = /* @__PURE__ */ new Map();
    for (const row of active)
      pairs.set(key(row), { ...row, unnamed: 0 });
    for (const row of unnamed)
      pairs.set(key(row), {
        active_tab_id: null,
        ...pairs.get(key(row)),
        ...row,
        unnamed: 1
      });
    return [...pairs.values()];
  }
  get windowProfiles() {
    const windows = new Set(this.windows.map((window) => window.id));
    return this.database.all(select3("windows_profiles", "window_id, profile_id")).filter((row) => windows.has(row.window_id));
  }
  // Each profile's color, an archived WBSNamedColorOption.
  color(profile) {
    const setting = this.database.all(select3("settings", "parent")).find((row) => row.parent === profile.id && row.key === "ProfileColor");
    return setting?.value instanceof Uint8Array ? dictionary(decodeArchive(setting.value)) : {};
  }
  // A row's own attributes and its attributes local to this Mac.
  attributes(row) {
    let found = this.#attributes.get(row.id);
    if (found === void 0) {
      found = [plist(row.extra_attributes), plist(row.local_attributes)];
      this.#attributes.set(row.id, found);
    }
    return found;
  }
  windowState(window) {
    return plist(window.extra_attributes);
  }
  row(id2) {
    return this.#byId.get(id2);
  }
  uuid(id2) {
    return text(this.#byId.get(id2)?.external_uuid);
  }
  windowUuid(id2) {
    return text(this.#windows.find((window) => window.id === id2)?.uuid);
  }
  kind(row) {
    const named = namedSpecials.get(row.external_uuid);
    if (named !== void 0)
      return named;
    if (Number(row.special_id) > 0)
      return "special";
    if (row.subtype === favoritesSubtype)
      return "favorites";
    if (row.subtype === deviceSubtype)
      return "device";
    if (this.#windows.some((window) => window.private_tab_group_id === row.id))
      return "private";
    if (this.#windows.some((window) => window.local_tab_group_id === row.id))
      return "local";
    return this.attributes(row)[0].IsUnnamed === true ? "unnamed" : "named";
  }
  // The profile a row belongs to: its nearest profile folder; under the root,
  // the default profile; a window's own groups, that window's profile; a
  // tab's page context names its profile. NULL when Safari records none.
  profileOf(row) {
    if (row.type !== folder) {
      const context = dictionary(this.attributes(row)[1].TabPageContextIDKey);
      const named = text(context.profileIdentifier);
      if (named !== null)
        return named;
    }
    for (let current = row; current !== void 0; current = this.#byId.get(current.parent)) {
      if (current.type === folder && current.subtype === profileSubtype)
        return text(current.external_uuid);
      if (current.parent === rootId)
        return defaultProfile;
      const window = this.#windows.find((window2) => window2.local_tab_group_id === current?.id || window2.private_tab_group_id === current?.id || window2.active_tab_group_id === current?.id);
      if (window !== void 0)
        return this.uuid(window.active_profile_id);
    }
    return null;
  }
  historyEntries() {
    return this.tabs.flatMap((tab) => {
      const state = this.attributes(tab)[1].SessionState;
      if (!(state instanceof Uint8Array))
        return [];
      const session = dictionary(dictionary(parseBinaryPlist(state.subarray(4))).SessionHistory);
      const current = session.SessionHistoryCurrentIndex;
      return list(session.SessionHistoryEntries).map((entry, position) => ({
        tab,
        entry: dictionary(entry),
        position,
        current: position === current
      }));
    });
  }
  #included(row) {
    return selected(this.scope.collectionIds, this.profileOf(row));
  }
};
var plist = (value) => value instanceof Uint8Array ? dictionary(parseBinaryPlist(value)) : {};

// packages/sources/apple/safari/dist/safari-scan.js
var storeFiles = ({ directory, container }) => ({
  history: join2(directory, "History.db"),
  tabs: join2(container, "SafariTabs.db"),
  cloudTabs: join2(container, "CloudTabs.db"),
  bookmarks: join2(directory, "Bookmarks.plist"),
  closedTabs: join2(directory, "RecentlyClosedTabs.plist"),
  downloads: join2(directory, "Downloads.plist")
});
var profileHistory = ({ directory, container }, serverId) => serverId === defaultProfile ? join2(directory, "History.db") : join2(container, "Profiles", serverId, "History.db");
var databaseStores = /* @__PURE__ */ new Set([
  "history",
  "tabs",
  "cloudTabs"
]);
var SafariScan = class _SafariScan {
  #resources;
  #stores;
  constructor(resources, stores) {
    this.#resources = resources;
    this.#stores = stores;
  }
  static async open(location, stores, scope) {
    var _stack = [];
    try {
      const files = storeFiles(location);
      const resources = __using(_stack, new AsyncDisposableStack(), true);
      const database = async (path, columns) => resources.use(await SafariDatabase.open(path, columns));
      const open2 = async (store, reader) => {
        if (!stores.has(store))
          return void 0;
        try {
          return { reader: await reader() };
        } catch (error) {
          return { error };
        }
      };
      const opened = {
        // Each profile's History.db, pinned on its own; SafariTabs.db lists them.
        history: await open2("history", async () => {
          const profiles = new TabsReader(await database(files.tabs, tabsColumns), {}).allProfiles;
          const readers2 = [];
          for (const profile of profiles) {
            const serverId = text(profile.server_id);
            const profileId5 = text(profile.external_uuid);
            if (serverId === null || profileId5 === null)
              throw new TypeError("A Safari profile has no identifier");
            readers2.push(new HistoryReader(await database(profileHistory(location, serverId), historyColumns), profileId5, scope));
          }
          return readers2;
        }),
        tabs: await open2("tabs", async () => new TabsReader(await database(files.tabs, tabsColumns), scope)),
        cloudTabs: await open2("cloudTabs", async () => new CloudTabsReader(await database(files.cloudTabs, cloudTabsColumns))),
        bookmarks: await open2("bookmarks", async () => new BookmarksReader(await readSafariPlist(files.bookmarks))),
        closedTabs: await open2("closedTabs", async () => new ClosedTabsReader(await readSafariPlist(files.closedTabs), scope)),
        downloads: await open2("downloads", async () => new DownloadsReader(await readSafariPlist(files.downloads), scope))
      };
      return new _SafariScan(resources.move(), opened);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
  get history() {
    return this.#reader("history");
  }
  get tabs() {
    return this.#reader("tabs");
  }
  get downloads() {
    return this.#reader("downloads");
  }
  get cloudTabs() {
    return this.#reader("cloudTabs");
  }
  get bookmarks() {
    return this.#reader("bookmarks");
  }
  get closedTabs() {
    return this.#reader("closedTabs");
  }
  #reader(store) {
    const opened = this.#stores[store];
    if (opened === void 0)
      throw new Error(`Safari ${store} was not opened for this run`);
    if ("error" in opened)
      throw opened.error;
    return opened.reader;
  }
  [Symbol.asyncDispose]() {
    return this.#resources.disposeAsync();
  }
};

// packages/sources/apple/safari/dist/safari-stream.js
var text2 = { type: "string" };
var nullableText = { type: ["string", "null"] };
var integer2 = { type: "integer" };
var nullableInteger = { type: ["integer", "null"] };
var safariFields = {
  id: { ...text2, minLength: 1 },
  nullableId: { ...nullableText, minLength: 1 },
  text: text2,
  nullableText,
  integer: integer2,
  nullableInteger,
  ordinal: { ...integer2, minimum: 0 },
  nullableNumber: { type: ["number", "null"] },
  boolean: { type: "boolean" },
  timestamp: { ...text2, format: "date-time" },
  nullableTimestamp: { ...nullableText, format: "date-time" },
  profileId: {
    ...text2,
    minLength: 1,
    description: "Safari profile identifier; refers to profiles.id within this source. The default profile is DefaultProfile."
  }
};
var SafariStream = class {
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  sourceDefinedCursor = true;
  emitsDeletes = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async read(scan) {
    return validateRecords(this, this.rows(scan).map((row) => this.record(row, scan)), "Safari");
  }
  // The file a record carries, for streams that support file reads.
  file(_record, _scan) {
    return null;
  }
};

// packages/sources/apple/safari/dist/streams/bookmarks-stream.js
var { nullableText: nullableText2 } = safariFields;
var kinds = /* @__PURE__ */ new Map([
  ["WebBookmarkTypeList", "folder"],
  ["WebBookmarkTypeLeaf", "bookmark"],
  ["WebBookmarkTypeProxy", "proxy"]
]);
var properties = {
  id: {
    ...safariFields.id,
    description: "Bookmark UUID (WebBookmarkUUID); bookmarks.parentId refers to it."
  },
  parentId: {
    ...safariFields.nullableId,
    description: "The containing folder; refers to bookmarks.id. NULL for the top-level folders."
  },
  position: {
    ...safariFields.ordinal,
    description: "Index within the containing folder, as Safari orders it."
  },
  kind: {
    ...safariFields.text,
    enum: [...kinds.values()],
    description: "folder, bookmark, or proxy (a placeholder such as the History entry of the Bookmarks menu)."
  },
  title: {
    ...nullableText2,
    description: "Displayed title. Safari names its top-level folders BookmarksBar (Favorites), BookmarksMenu and com.apple.ReadingList. NULL when absent."
  },
  url: {
    ...nullableText2,
    description: "The bookmarked URL; NULL for folders and proxies."
  },
  identifier: {
    ...nullableText2,
    description: "Safari identifier of a built-in entry (WebBookmarkIdentifier), such as History; NULL otherwise."
  },
  hidden: {
    ...safariFields.boolean,
    description: "Whether Safari omits the entry from its bookmark lists."
  },
  addedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the bookmark was added; NULL when Safari did not record it."
  },
  description: {
    ...nullableText2,
    description: "Description shown under the bookmark: the one the user typed, or preview text Safari fetched; NULL when none."
  },
  descriptionUserDefined: {
    ...safariFields.boolean,
    description: "Whether the user typed the description."
  },
  featureText: {
    ...nullableText2,
    description: "Summary text Safari fetched for the page; NULL when it fetched none."
  },
  metadataFetchFailures: {
    ...safariFields.nullableInteger,
    description: "Times Safari failed to fetch page details for the sidebar; NULL when none were recorded."
  },
  serverId: {
    ...nullableText2,
    description: "iCloud identifier of the entry; profiles.favoritesFolderServerId refers to a profile Favorites folder by it. NULL when never synced."
  }
};
var BookmarksStream = class extends SafariStream {
  name = "bookmarks";
  store = "bookmarks";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per bookmark, folder and proxy in Safari bookmarks (Bookmarks.plist), including the Reading List folder but not its items, which readingListItems holds. Relationships name streams in this source, not physical destination tables.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.bookmarks.bookmarks;
  }
  record({ node, parentId, position }) {
    return {
      id: node.WebBookmarkUUID,
      parentId,
      position,
      kind: kinds.get(node.WebBookmarkType) ?? null,
      title: text(node.Title) ?? text(dictionary(node.URIDictionary).title),
      url: text(node.URLString),
      identifier: text(node.WebBookmarkIdentifier),
      hidden: flag(node.ShouldOmitFromUI),
      addedAt: plistTime(node.dateAdded),
      description: text(node.previewText),
      descriptionUserDefined: flag(node.previewTextIsUserDefined),
      featureText: text(node.featureText),
      metadataFetchFailures: integer(dictionary(node.ReadingListNonSync).BookmarkSidebarMetadataFetchFailuresDueToUnknownOrNonRecoverableErrorKey),
      serverId: text(dictionary(node.Sync).ServerID)
    };
  }
};

// packages/sources/apple/safari/dist/streams/closed-tabs-stream.js
var { boolean, nullableText: nullableText3, nullableTimestamp } = safariFields;
var properties2 = {
  id: { ...safariFields.id, description: "Closed tab UUID." },
  closedWindowId: {
    ...safariFields.nullableId,
    description: "The recently closed window that held the tab; refers to closedWindows.id. NULL for a tab closed on its own."
  },
  position: {
    ...safariFields.ordinal,
    description: "Index in the Recently Closed list for a tab closed on its own, or among its closed window tabs."
  },
  windowId: {
    ...nullableText3,
    description: "UUID of the window the tab was in; NULL when not recorded."
  },
  profileId: safariFields.profileId,
  title: { ...nullableText3, description: "Tab title; NULL when absent." },
  url: { ...nullableText3, description: "Tab URL; NULL when absent." },
  closedAt: {
    ...nullableTimestamp,
    description: "When the tab was closed."
  },
  lastVisitedAt: {
    ...nullableTimestamp,
    description: "When the tab last loaded a page; NULL when never."
  },
  tabIndex: {
    ...safariFields.nullableInteger,
    description: "Position of the tab in its tab bar; NULL when not recorded."
  },
  tabGroupId: {
    ...nullableText3,
    description: "The tab group the tab belonged to; NULL when not recorded."
  },
  tabGroupType: {
    ...boolean,
    description: "Safari TabGroupTypeForTabKey flag as stored; true in every entry observed, and Apple does not document it."
  },
  ancestorTabIds: {
    type: "array",
    items: { type: "string" },
    description: "UUIDs of the tabs this tab was opened from, in stored order; empty when opened directly."
  },
  muted: { ...boolean, description: "Whether the tab was muted." },
  disposable: {
    ...boolean,
    description: "Safari IsDisposable flag as stored."
  },
  safeToLoad: {
    ...boolean,
    description: "Safari SafeToLoad flag as stored."
  }
};
var ClosedTabsStream = class extends SafariStream {
  name = "closedTabs";
  store = "closedTabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per tab Safari lists under History > Recently Closed (RecentlyClosedTabs.plist), closed on its own or with its window. Relationships name streams in this source, not physical destination tables.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.closedTabs.tabs;
  }
  record({ state, closedWindowId, position }) {
    return {
      id: state.TabUUID,
      closedWindowId,
      position,
      windowId: text(state.WindowUUID),
      profileId: state.ProfileUUID,
      title: text(state.TabTitle),
      url: text(state.TabURL),
      closedAt: plistTime(state.DateClosed),
      lastVisitedAt: plistTime(state.LastVisitTime),
      tabIndex: integer(state.TabIndex),
      tabGroupId: text(state.TabGroupForTab),
      tabGroupType: flag(state.TabGroupTypeForTabKey),
      ancestorTabIds: strings(state.AncestorTabUUIDsKey),
      muted: flag(state.IsMuted),
      disposable: flag(state.IsDisposable),
      safeToLoad: flag(state.SafeToLoad)
    };
  }
};

// packages/sources/apple/safari/dist/streams/closed-window-active-tabs-stream.js
var properties3 = {
  windowId: {
    ...safariFields.id,
    description: "The closed window; refers to closedWindows.id."
  },
  tabGroupId: {
    ...safariFields.id,
    description: "A tab group the window showed."
  },
  tabId: {
    ...safariFields.id,
    description: "The tab that was active in that group; closedTabs.id when Safari kept the tab."
  }
};
var ClosedWindowActiveTabsStream = class extends SafariStream {
  name = "closedWindowActiveTabs";
  store = "closedTabs";
  primaryKey = ["windowId", "tabGroupId"];
  jsonSchema = {
    type: "object",
    description: "One source record per tab group of a recently closed window, naming the tab active in it (RecentlyClosedTabs.plist TabGroupsToActiveTabs). Relationships name streams in this source, not physical destination tables.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.closedTabs.windows.flatMap(({ state }) => Object.entries(dictionary(state.TabGroupsToActiveTabs)).map(([tabGroupId, tabId]) => ({
      windowId: state.WindowUUID,
      tabGroupId,
      tabId
    })));
  }
  record(entry) {
    return entry;
  }
};

// packages/sources/apple/safari/dist/window-state.js
var { boolean: boolean2, nullableText: nullableText4, nullableInteger: nullableInteger2 } = safariFields;
var windowStateFields = {
  closedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the window was closed; NULL while it is open."
  },
  private: { ...boolean2, description: "Whether it is a private window." },
  popup: { ...boolean2, description: "Whether it is a popup window." },
  miniaturized: {
    ...boolean2,
    description: "Whether it is minimized to the Dock."
  },
  unnamedTabGroupIds: {
    type: "array",
    items: { type: "string" },
    description: "Unnamed tab groups of the window."
  },
  selectedTabIndex: {
    ...nullableInteger2,
    description: "Index of the selected tab; NULL when not recorded."
  },
  selectedPinnedTabIndex: {
    ...nullableInteger2,
    description: "Index of the selected pinned tab; NULL when no pinned tab is selected."
  },
  tabBarHidden: { ...boolean2, description: "Whether the tab bar is hidden." },
  favoritesBarHidden: {
    ...boolean2,
    description: "Whether the Favorites bar is hidden."
  },
  readingListSidebarVisible: {
    ...boolean2,
    description: "Whether the window prefers the Reading List sidebar."
  },
  sidebarMode: {
    ...nullableInteger2,
    description: "Safari sidebar mode code, as stored; NULL when not recorded."
  },
  frame: {
    ...nullableText4,
    description: 'Window content rectangle as Safari stores it, "{{x, y}, {width, height}}"; NULL when not recorded.'
  },
  addressFieldText: {
    ...nullableText4,
    description: "Text typed into the address field and not yet submitted; NULL when none."
  }
};
var windowState = (state) => ({
  closedAt: plistTime(state.DateClosed),
  private: flag(state.IsPrivateWindow),
  popup: flag(state.IsPopupWindow),
  miniaturized: flag(state.Miniaturized),
  unnamedTabGroupIds: strings(state.UnnamedTabGroupUUIDs),
  selectedTabIndex: integer(state.SelectedTabIndex),
  selectedPinnedTabIndex: integer(state.SelectedPinnedTabIndex),
  tabBarHidden: flag(state.TabBarHidden),
  favoritesBarHidden: flag(state.FavoritesBarHidden),
  readingListSidebarVisible: flag(state.PrefersReadingListSidebarVisible),
  sidebarMode: integer(state.WindowUnifiedSidebarMode),
  frame: text(state.WindowContentRect),
  addressFieldText: text(state.CustomUnifiedFieldText)
});

// packages/sources/apple/safari/dist/streams/closed-windows-stream.js
var properties4 = {
  id: {
    ...safariFields.id,
    description: "Closed window UUID; closedTabs.closedWindowId and closedWindowActiveTabs.windowId refer to it."
  },
  position: {
    ...safariFields.ordinal,
    description: "Index in the Recently Closed list, as Safari orders it."
  },
  profileId: safariFields.profileId,
  activeTabGroupId: {
    ...safariFields.nullableText,
    description: "The tab group shown when the window closed; closedTabs.tabGroupId uses the same identifiers. NULL when not recorded."
  },
  ...windowStateFields
};
var ClosedWindowsStream = class extends SafariStream {
  name = "closedWindows";
  store = "closedTabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per window Safari lists under History > Recently Closed (RecentlyClosedTabs.plist). Its tabs are in closedTabs. Relationships name streams in this source, not physical destination tables.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.closedTabs.windows;
  }
  record({ state, position }) {
    return {
      id: state.WindowUUID,
      position,
      profileId: state.ProfileUUID,
      activeTabGroupId: text(state.activeTabGroupUUID),
      ...windowState(state)
    };
  }
};

// packages/sources/apple/safari/dist/streams/cloud-tab-close-requests-stream.js
var properties5 = {
  id: {
    ...safariFields.id,
    description: "iCloud Tabs close request identifier."
  },
  deviceId: {
    ...safariFields.id,
    description: "The device asked to close the tab; refers to cloudTabDevices.id."
  },
  url: { ...safariFields.text, description: "URL of the tab to close." },
  tabId: {
    ...safariFields.id,
    description: "The tab to close; refers to cloudTabs.id while that device still lists it."
  }
};
var CloudTabCloseRequestsStream = class extends SafariStream {
  name = "cloudTabCloseRequests";
  store = "cloudTabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per pending request, made from any device, to close a tab on another device through iCloud Tabs (CloudTabs.db). Relationships name streams in this source, not physical destination tables.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.cloudTabs.closeRequests;
  }
  record(row) {
    return {
      id: row.close_request_uuid,
      deviceId: row.destination_device_uuid,
      url: row.url,
      tabId: row.tab_uuid
    };
  }
};

// packages/sources/apple/safari/dist/streams/cloud-tab-devices-stream.js
var { boolean: boolean3, nullableText: nullableText5 } = safariFields;
var properties6 = {
  id: {
    ...safariFields.id,
    description: "iCloud Tabs device identifier; cloudTabs.deviceId and cloudTabCloseRequests.deviceId refer to it."
  },
  name: {
    ...nullableText5,
    description: "Device name as the device reports it; NULL when absent."
  },
  type: {
    ...nullableText5,
    description: "Apple model identifier of the device, such as com.apple.iphone-15-pro-5; NULL when absent."
  },
  duplicateName: {
    ...boolean3,
    description: "Whether another device on the account has the same name."
  },
  ephemeral: {
    ...boolean3,
    description: "Whether Safari treats the device as temporary."
  },
  modifiedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the device last changed its iCloud Tabs record."
  }
};
var CloudTabDevicesStream = class extends SafariStream {
  name = "cloudTabDevices";
  store = "cloudTabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per device sharing its open tabs through iCloud Tabs (CloudTabs.db), as Safari on this Mac last fetched them. Safari fetches only while it runs. Relationships name streams in this source, not physical destination tables.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.cloudTabs.devices;
  }
  record(row) {
    return {
      id: row.device_uuid,
      name: text(row.device_name),
      type: text(row.device_type_identifier),
      duplicateName: flag(row.has_duplicate_device_name),
      ephemeral: flag(row.is_ephemeral_device),
      modifiedAt: appleTime(row.last_modified)
    };
  }
};

// packages/sources/apple/safari/dist/streams/cloud-tab-positions-stream.js
var properties7 = {
  tabId: {
    ...safariFields.id,
    description: "The tab; refers to cloudTabs.id."
  },
  position: {
    ...safariFields.ordinal,
    description: "Index of this entry in the tab position."
  },
  changeId: {
    ...safariFields.integer,
    description: "The change that wrote this sort value."
  },
  sortValue: {
    ...safariFields.integer,
    description: "Ordering value iCloud Tabs uses to place the tab among its device tabs."
  },
  deviceId: {
    ...safariFields.id,
    description: "Identifier of the device that wrote this sort value, as iCloud Tabs ordering records it; it is not a cloudTabDevices.id."
  }
};
var CloudTabPositionsStream = class extends SafariStream {
  name = "cloudTabPositions";
  store = "cloudTabs";
  primaryKey = ["tabId", "position"];
  jsonSchema = {
    type: "object",
    description: "One source record per sort value in an iCloud tab position (CloudTabs.db cloud_tabs.position), which orders the tabs of a device. Relationships name streams in this source, not physical destination tables.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.cloudTabs.positions();
  }
  record({ tab, entry, index }) {
    return {
      tabId: tab.tab_uuid,
      position: index,
      changeId: entry.changeID,
      sortValue: entry.sortValue,
      deviceId: entry.deviceIdentifier
    };
  }
};

// packages/sources/apple/safari/dist/streams/cloud-tabs-stream.js
var { boolean: boolean4, nullableText: nullableText6 } = safariFields;
var properties8 = {
  id: {
    ...safariFields.id,
    description: "iCloud Tabs tab identifier; cloudTabPositions.tabId and cloudTabCloseRequests.tabId refer to it."
  },
  deviceId: {
    ...safariFields.id,
    description: "The device the tab is open on; refers to cloudTabDevices.id."
  },
  title: {
    ...nullableText6,
    description: "Page title; NULL when the page had none."
  },
  url: { ...safariFields.text, description: "The page URL." },
  showingReader: {
    ...boolean4,
    description: "Whether the tab shows the page in Reader."
  },
  pinned: { ...boolean4, description: "Whether the tab is pinned." },
  readerScrollPageIndex: {
    ...safariFields.nullableInteger,
    description: "Page index Reader was scrolled to; NULL when not recorded."
  },
  sceneId: {
    ...nullableText6,
    description: "The device window (scene) holding the tab; NULL when not recorded."
  },
  lastViewedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the tab was last viewed on its device; NULL when never recorded (stored as 0)."
  },
  topic: {
    ...nullableText6,
    description: "Topic Safari assigned to the page; NULL when none."
  }
};
var CloudTabsStream = class extends SafariStream {
  name = "cloudTabs";
  store = "cloudTabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per tab open on another device through iCloud Tabs (CloudTabs.db), as Safari on this Mac last fetched them. Relationships name streams in this source, not physical destination tables.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return scan.cloudTabs.tabs;
  }
  record(row) {
    return {
      id: row.tab_uuid,
      deviceId: row.device_uuid,
      title: text(row.title),
      url: row.url,
      showingReader: flag(row.is_showing_reader),
      pinned: flag(row.is_pinned),
      readerScrollPageIndex: integer(row.reader_scroll_position_page_index),
      sceneId: text(row.scene_id),
      lastViewedAt: row.last_viewed_time === 0 ? null : appleTime(row.last_viewed_time),
      topic: text(row.topic_title)
    };
  }
};

// packages/sources/apple/safari/dist/streams/downloads-stream.js
import { existsSync } from "node:fs";
var { boolean: boolean5, nullableText: nullableText7, nullableTimestamp: nullableTimestamp2, nullableInteger: nullableInteger3 } = safariFields;
var properties9 = {
  id: { ...safariFields.id, description: "Download identifier." },
  profileId: {
    ...safariFields.nullableId,
    description: "The profile that downloaded the file; refers to profiles.id. NULL when not recorded."
  },
  url: { ...safariFields.text, description: "URL the file came from." },
  path: {
    ...safariFields.text,
    description: "Where Safari saved the file. For an archive Safari opened on its own, the archive inside a .download folder that no longer exists."
  },
  openedPath: {
    ...nullableText7,
    description: "For an archive Safari opened on its own, the first extracted file as Safari recorded it, inside the .download folder; Safari moves the extracted files next to it. NULL otherwise."
  },
  addedAt: {
    ...nullableTimestamp2,
    description: "When the download started."
  },
  finishedAt: {
    ...nullableTimestamp2,
    description: "When the download finished; NULL while unfinished."
  },
  bytesReceived: {
    ...nullableInteger3,
    description: "Bytes downloaded."
  },
  bytesTotal: {
    ...nullableInteger3,
    description: "Expected size in bytes, as Safari recorded it."
  },
  removeWhenDone: {
    ...boolean5,
    description: "Whether Safari removes the entry once finished."
  },
  availableLocally: {
    ...boolean5,
    description: "Whether the file at path exists on this Mac."
  }
};
var DownloadsStream = class extends SafariStream {
  name = "downloads";
  store = "downloads";
  primaryKey = ["id"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One source record per entry of the Safari Downloads list (Downloads.plist), with the downloaded file when it is still where Safari saved it. Clearing the list removes the entries, not the files. Relationships name streams in this source, not physical destination tables.",
    properties: properties9,
    required: Object.keys(properties9)
  };
  rows(scan) {
    return scan.downloads.downloads;
  }
  record(entry) {
    const path = entry.DownloadEntryPath;
    return {
      id: entry.DownloadEntryIdentifier,
      profileId: text(entry.DownloadEntryProfileUUIDStringKey),
      url: entry.DownloadEntryURL,
      path,
      openedPath: text(entry.DownloadEntryPostPath),
      addedAt: plistTime(entry.DownloadEntryDateAddedKey),
      finishedAt: plistTime(entry.DownloadEntryDateFinishedKey),
      bytesReceived: integer(entry.DownloadEntryProgressBytesSoFar),
      bytesTotal: integer(entry.DownloadEntryProgressTotalToLoad),
      removeWhenDone: flag(entry.DownloadEntryRemoveWhenDoneKey),
      availableLocally: typeof path === "string" && path !== "" && existsSync(path)
    };
  }
  // The original file, not a copy: downloads reach gigabytes and readers
  // only read it.
  file(record) {
    return record.availableLocally ? record.path : null;
  }
};

// packages/sources/apple/safari/dist/streams/history-item-tags-stream.js
var properties10 = {
  profileId: safariFields.profileId,
  itemId: {
    ...safariFields.integer,
    description: "The tagged URL; refers to historyItems.id."
  },
  tagId: {
    ...safariFields.integer,
    description: "The topic; refers to historyTags.id."
  },
  taggedAt: {
    ...safariFields.timestamp,
    description: "When Safari tagged the item."
  }
};
var HistoryItemTagsStream = class extends SafariStream {
  name = "historyItemTags";
  store = "history";
  primaryKey = ["profileId", "itemId", "tagId"];
  jsonSchema = {
    type: "object",
    description: "One source record per topic Safari assigned to a history item (History.db history_items_to_tags). Relationships name streams in this source, not physical destination tables.",
    properties: properties10,
    required: Object.keys(properties10)
  };
  rows(scan) {
    return scan.history.flatMap((history) => history.itemTags);
  }
  record(row) {
    return {
      profileId: row.$profile,
      itemId: row.history_item,
      tagId: row.tag_id,
      taggedAt: appleTime(row.timestamp)
    };
  }
};

// packages/sources/apple/safari/dist/streams/history-items-stream.js
var { profileId, id, nullableText: nullableText8, ordinal, boolean: boolean6 } = safariFields;
var countList = { type: "integer", minimum: 0 };
var properties11 = {
  profileId,
  id: {
    ...safariFields.integer,
    description: "History.db history_items.id; historyVisits.itemId and historyItemTags.itemId refer to it within the same profile."
  },
  url: { ...safariFields.text, description: "The page URL, unique per item." },
  domainExpansion: {
    ...nullableText8,
    description: "The part of the host Safari matches typed text against beyond the registrable domain, such as a subdomain; NULL when Safari recorded none."
  },
  visitCount: {
    ...ordinal,
    description: "Visits Safari counts for this URL across its history."
  },
  visitCountScore: {
    ...safariFields.integer,
    description: "Safari ranking score derived from recent visits, used for suggestions and Top Sites."
  },
  dailyVisitCounts: {
    type: "array",
    items: countList,
    description: "Per-day values Safari stores for ranking, as stored (daily_visit_counts). They are weighted, not raw visit counts (a single visit reads 20), and Safari does not store which day the list starts on or its order."
  },
  weeklyVisitCounts: {
    type: ["array", "null"],
    items: countList,
    description: "Per-week values Safari stores for ranking, as stored (weekly_visit_counts), weighted like dailyVisitCounts; NULL until Safari has recorded any."
  },
  autocompleteTriggers: {
    type: ["array", "null"],
    items: { type: "string" },
    description: "Typed prefixes that the user completed to this URL in the address field; NULL when none were recorded."
  },
  statusCode: {
    ...safariFields.nullableInteger,
    description: "HTTP status Safari recorded for the last load; NULL when it recorded none (stored as 0)."
  },
  derivedCountsStale: {
    ...boolean6,
    description: "Whether Safari marked visitCountScore and the count lists for recomputation."
  }
};
var HistoryItemsStream = class extends SafariStream {
  name = "historyItems";
  store = "history";
  primaryKey = ["profileId", "id"];
  jsonSchema = {
    type: "object",
    description: "One source record per URL in Safari history (History.db history_items), with the visit counts Safari ranks it by. Relationships name streams in this source, not physical destination tables.",
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(scan) {
    return scan.history.flatMap((history) => history.items);
  }
  record(row) {
    return {
      profileId: row.$profile,
      id: row.id,
      url: row.url,
      domainExpansion: text(row.domain_expansion),
      visitCount: row.visit_count,
      visitCountScore: row.visit_count_score,
      dailyVisitCounts: counts(row.daily_visit_counts),
      weeklyVisitCounts: counts(row.weekly_visit_counts),
      autocompleteTriggers: triggers(row.autocomplete_triggers),
      statusCode: integer(row.status_code) || null,
      derivedCountsStale: flag(row.should_recompute_derived_visit_counts)
    };
  }
};

// packages/sources/apple/safari/dist/streams/history-tags-stream.js
var { profileId: profileId2 } = safariFields;
var properties12 = {
  profileId: profileId2,
  id: {
    ...safariFields.integer,
    description: "History.db history_tags.id; historyItemTags.tagId refers to it within the same profile."
  },
  type: {
    ...safariFields.integer,
    description: "Safari tag type as stored (1 observed: a topic)."
  },
  level: {
    ...safariFields.integer,
    description: "Safari tag level as stored (200 observed)."
  },
  identifier: {
    ...safariFields.id,
    description: "The topic identifier, a Wikidata item ID such as Q2063 for topics."
  },
  title: { ...safariFields.text, description: "The topic name." },
  modifiedAt: {
    ...safariFields.timestamp,
    description: "When Safari last changed the tag."
  },
  itemCount: {
    ...safariFields.integer,
    description: "Items Safari counts under the tag. Safari maintains it by trigger, so it can exceed the historyItemTags rows left after visits expire."
  }
};
var HistoryTagsStream = class extends SafariStream {
  name = "historyTags";
  store = "history";
  primaryKey = ["profileId", "id"];
  jsonSchema = {
    type: "object",
    description: "One source record per topic Safari derived from browsing history (History.db history_tags). Relationships name streams in this source, not physical destination tables.",
    properties: properties12,
    required: Object.keys(properties12)
  };
  rows(scan) {
    return scan.history.flatMap((history) => history.tags);
  }
  record(row) {
    return {
      profileId: row.$profile,
      id: row.id,
      type: row.type,
      level: row.level,
      identifier: row.identifier,
      title: row.title,
      modifiedAt: appleTime(row.modification_timestamp),
      itemCount: row.item_count
    };
  }
};

// packages/sources/apple/safari/dist/streams/history-tombstones-stream.js
var { profileId: profileId3, nullableText: nullableText9, nullableTimestamp: nullableTimestamp3 } = safariFields;
var properties13 = {
  profileId: profileId3,
  id: {
    ...safariFields.integer,
    description: "History.db history_tombstones.id."
  },
  startAt: {
    ...nullableTimestamp3,
    description: "Start of the cleared time range; NULL when it is unbounded (Safari stores the year 1)."
  },
  endAt: {
    ...nullableTimestamp3,
    description: "End of the cleared time range; NULL when it is unbounded."
  },
  url: {
    ...nullableText9,
    description: "The URL whose history was removed, when Safari stored it as text; NULL otherwise."
  },
  encryptedUrl: {
    ...nullableText9,
    description: "The removed URL as Safari stores it for iCloud sync, encrypted, in base64. Safari 27 stores deleted URLs this way; NULL when the whole range was cleared or the URL is plain text."
  },
  generation: {
    ...safariFields.integer,
    description: "Safari history sync generation of the deletion."
  },
  deviceId: {
    ...nullableText9,
    description: "Identifier of the device that made the deletion, if recorded."
  },
  attributes: {
    ...safariFields.ordinal,
    description: "Safari tombstone attribute bit mask as stored; Apple does not document the bits."
  }
};
var HistoryTombstonesStream = class extends SafariStream {
  name = "historyTombstones";
  store = "history";
  primaryKey = ["profileId", "id"];
  jsonSchema = {
    type: "object",
    description: "One source record per history deletion Safari keeps to sync to other devices (History.db history_tombstones): a removed URL or a cleared time range. Visits Safari expires by age leave no tombstone. Relationships name streams in this source, not physical destination tables.",
    properties: properties13,
    required: Object.keys(properties13)
  };
  rows(scan) {
    return scan.history.flatMap((history) => history.tombstones);
  }
  record(row) {
    return {
      profileId: row.$profile,
      id: row.id,
      startAt: appleTime(row.start_time),
      endAt: appleTime(row.end_time),
      url: text(row.url),
      encryptedUrl: base64(row.url),
      generation: row.generation,
      deviceId: text(row.udid),
      attributes: row.attributes
    };
  }
};

// packages/sources/apple/safari/dist/streams/history-visits-stream.js
var { profileId: profileId4, boolean: boolean7, nullableText: nullableText10, nullableInteger: nullableInteger4 } = safariFields;
var properties14 = {
  profileId: profileId4,
  id: {
    ...safariFields.integer,
    description: "History.db history_visits.id; redirectSourceId and redirectDestinationId refer to it within the same profile."
  },
  itemId: {
    ...safariFields.integer,
    description: "The visited URL; refers to historyItems.id."
  },
  visitedAt: {
    ...safariFields.timestamp,
    description: "When the visit happened."
  },
  title: {
    ...nullableText10,
    description: "Page title at this visit; NULL when the page had none."
  },
  loadSuccessful: {
    ...boolean7,
    description: "Whether the page finished loading."
  },
  httpNonGet: {
    ...boolean7,
    description: "Whether the visit was a non-GET request, such as a form POST."
  },
  synthesized: {
    ...boolean7,
    description: "Whether Safari synthesized the visit rather than recording a navigation."
  },
  redirectSourceId: {
    ...nullableInteger4,
    description: "The visit that redirected to this one; refers to historyVisits.id. NULL when none did."
  },
  redirectDestinationId: {
    ...nullableInteger4,
    description: "The visit this one redirected to; refers to historyVisits.id. NULL when it did not redirect."
  },
  origin: {
    ...safariFields.ordinal,
    description: "Where the visit happened: 0 on this Mac, 1 on another device signed in to the same iCloud account whose history Safari synced here."
  },
  generation: {
    ...safariFields.integer,
    description: "Safari history sync generation that last wrote the visit; it grows with each local change."
  },
  attributes: {
    ...safariFields.ordinal,
    description: "Safari visit attribute bit mask as stored; Apple does not document the bits."
  },
  score: {
    ...safariFields.integer,
    description: "Safari ranking score of this visit (0 to 100 observed)."
  }
};
var HistoryVisitsStream = class extends SafariStream {
  name = "historyVisits";
  store = "history";
  primaryKey = ["profileId", "id"];
  jsonSchema = {
    type: "object",
    description: "One source record per page visit in Safari history (History.db history_visits), from this Mac and from other devices synced through iCloud while Safari ran. Safari removes visits older than its history retention setting. Relationships name streams in this source, not physical destination tables.",
    properties: properties14,
    required: Object.keys(properties14)
  };
  rows(scan) {
    return scan.history.flatMap((history) => history.visits);
  }
  record(row) {
    return {
      profileId: row.$profile,
      id: row.id,
      itemId: row.history_item,
      visitedAt: appleTime(row.visit_time),
      title: text(row.title),
      loadSuccessful: flag(row.load_successful),
      httpNonGet: flag(row.http_non_get),
      synthesized: flag(row.synthesized),
      redirectSourceId: integer(row.redirect_source),
      redirectDestinationId: integer(row.redirect_destination),
      origin: row.origin,
      generation: row.generation,
      attributes: row.attributes,
      score: row.score
    };
  }
};

// packages/sources/apple/safari/dist/streams/profile-start-page-sections-stream.js
var properties15 = {
  profileId: safariFields.profileId,
  position: {
    ...safariFields.ordinal,
    description: "Order of the section on the Start Page."
  },
  identifier: {
    ...safariFields.id,
    description: "Start Page section, such as favoritesItemIdentifier or readingListItemIdentifier."
  },
  enabled: {
    ...safariFields.boolean,
    description: "Whether the Start Page shows the section."
  }
};
var ProfileStartPageSectionsStream = class extends SafariStream {
  name = "profileStartPageSections";
  store = "tabs";
  primaryKey = ["profileId", "position"];
  jsonSchema = {
    type: "object",
    description: "One source record per Start Page section a profile customized (SafariTabs.db StartPageSectionsData). A profile that never customized its Start Page has none. Relationships name streams in this source, not physical destination tables.",
    properties: properties15,
    required: Object.keys(properties15)
  };
  rows(scan) {
    return scan.tabs.profiles.flatMap((profile) => {
      const data = scan.tabs.attributes(profile)[0].StartPageSectionsData;
      if (!(data instanceof Uint8Array))
        return [];
      const { Sections } = JSON.parse(Buffer.from(data).toString("utf8"));
      return Sections.map((section, position) => ({
        profile,
        position,
        section
      }));
    });
  }
  record({ profile, position, section }) {
    return {
      profileId: profile.external_uuid,
      position,
      identifier: section.Identifier,
      enabled: section.IsEnabled
    };
  }
};

// packages/sources/apple/safari/dist/streams/profiles-stream.js
var { nullableText: nullableText11, nullableNumber } = safariFields;
var component = { ...nullableNumber, minimum: 0, maximum: 1 };
var properties16 = {
  id: {
    ...safariFields.id,
    description: "Profile identifier (external_uuid); every profileId in this source refers to it. The profile Safari starts with is DefaultProfile."
  },
  serverId: {
    ...safariFields.id,
    description: "Profile iCloud identifier; names the folder Safari keeps the profile data in (DefaultProfile for the first profile)."
  },
  title: {
    ...nullableText11,
    description: "Profile name; NULL for the default profile, which Safari shows as Personal once other profiles exist."
  },
  position: {
    ...safariFields.integer,
    description: "Order Safari lists profiles in."
  },
  symbol: {
    ...nullableText11,
    description: "SF Symbol shown for the profile, such as person.fill."
  },
  colorName: {
    ...nullableText11,
    description: "Named profile color, such as heatherBlue or clear."
  },
  red: { ...component, description: "Profile color red component, 0 to 1." },
  green: {
    ...component,
    description: "Profile color green component, 0 to 1."
  },
  blue: { ...component, description: "Profile color blue component, 0 to 1." },
  alpha: {
    ...component,
    description: "Profile color opacity, 0 to 1; 0 for clear."
  },
  favoritesFolderServerId: {
    ...nullableText11,
    description: "The profile own Favorites folder; bookmarks.serverId refers to the same folder once Safari has written it. NULL when the profile shares the default Favorites."
  },
  addedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the profile was created; NULL when not recorded."
  },
  modifiedAt: {
    ...safariFields.nullableTimestamp,
    description: "When Safari last changed the profile; NULL when not recorded."
  }
};
var ProfilesStream = class extends SafariStream {
  name = "profiles";
  store = "tabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per Safari profile (SafariTabs.db). Each profile has its own history, tabs and tab groups. Relationships name streams in this source, not physical destination tables.",
    properties: properties16,
    required: Object.keys(properties16)
  };
  rows(scan) {
    return scan.tabs.profiles;
  }
  record(row, scan) {
    const [extra] = scan.tabs.attributes(row);
    const color = scan.tabs.color(row);
    return {
      id: row.external_uuid,
      serverId: row.server_id,
      title: text(row.title),
      position: row.order_index,
      symbol: text(extra.SymbolImageName),
      colorName: text(color.colorName),
      red: number(color.redComponent),
      green: number(color.greenComponent),
      blue: number(color.blueComponent),
      alpha: number(color.alphaComponent),
      favoritesFolderServerId: text(extra.CustomFavoritesFolderServerID),
      addedAt: plistTime(dictionary(extra["com.apple.Bookmark"]).DateAdded),
      modifiedAt: appleTime(row.last_modified)
    };
  }
};

// packages/sources/apple/safari/dist/streams/reading-list-items-stream.js
var { nullableText: nullableText12, nullableTimestamp: nullableTimestamp4, nullableInteger: nullableInteger5 } = safariFields;
var properties17 = {
  id: {
    ...safariFields.id,
    description: "Reading List item UUID (WebBookmarkUUID)."
  },
  position: {
    ...safariFields.ordinal,
    description: "Index in the Reading List, as Safari orders it."
  },
  title: {
    ...nullableText12,
    description: "Displayed title; NULL when absent."
  },
  url: { ...safariFields.text, description: "The saved URL." },
  addedAt: {
    ...nullableTimestamp4,
    description: "When the item was added to the Reading List."
  },
  lastViewedAt: {
    ...nullableTimestamp4,
    description: "When the item was last opened; NULL while it is unread."
  },
  previewText: {
    ...nullableText12,
    description: "Preview text Safari shows under the title; NULL when none."
  },
  imageUrl: {
    ...nullableText12,
    description: "URL of the preview image; NULL when none."
  },
  fetchedTitle: {
    ...nullableText12,
    description: "Page title Safari fetched for offline reading; NULL when none."
  },
  fetchedAt: {
    ...nullableTimestamp4,
    description: "When Safari last fetched the page for offline reading; NULL when never."
  },
  fetchResult: {
    ...nullableInteger5,
    description: "Safari result code of the last offline fetch, as stored; NULL when never fetched."
  },
  failedLoads: {
    ...nullableInteger5,
    description: "Offline fetches that failed with an unknown or unrecoverable error; NULL when none were recorded."
  },
  addedLocally: {
    ...safariFields.boolean,
    description: "Whether the item was added on this Mac rather than synced from another device."
  },
  metadataFetchFailures: {
    ...nullableInteger5,
    description: "Times Safari failed to fetch page details for the sidebar; NULL when none were recorded."
  },
  featureText: {
    ...nullableText12,
    description: "Summary text Safari fetched for the page; NULL when it fetched none."
  }
};
var ReadingListItemsStream = class extends SafariStream {
  name = "readingListItems";
  store = "bookmarks";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per Safari Reading List item (Bookmarks.plist). Offline copies of the pages are not exported. Relationships name streams in this source, not physical destination tables.",
    properties: properties17,
    required: Object.keys(properties17)
  };
  rows(scan) {
    return scan.bookmarks.readingList;
  }
  record({ node, position }) {
    const saved = dictionary(node.ReadingList);
    const fetched = dictionary(node.ReadingListNonSync);
    return {
      id: node.WebBookmarkUUID,
      position,
      title: text(dictionary(node.URIDictionary).title),
      url: node.URLString,
      addedAt: plistTime(saved.DateAdded),
      lastViewedAt: plistTime(saved.DateLastViewed),
      previewText: text(saved.PreviewText) ?? text(node.previewText),
      imageUrl: text(node.imageURL),
      fetchedTitle: text(fetched.Title),
      fetchedAt: plistTime(fetched.DateLastFetched),
      fetchResult: integer(fetched.FetchResult),
      failedLoads: integer(fetched.NumberOfFailedLoadsWithUnknownOrNonRecoverableError),
      addedLocally: flag(fetched.AddedLocally),
      metadataFetchFailures: integer(fetched.BookmarkSidebarMetadataFetchFailuresDueToUnknownOrNonRecoverableErrorKey),
      featureText: text(node.featureText)
    };
  }
};

// packages/sources/apple/safari/dist/streams/tab-groups-stream.js
var { nullableId, nullableText: nullableText13 } = safariFields;
var properties18 = {
  id: {
    ...safariFields.id,
    description: "Tab group UUID; tabs.tabGroupId and tabGroups.parentId refer to it."
  },
  parentId: {
    ...nullableId,
    description: "The containing folder: another tabGroups.id, or a profiles.id. NULL for top-level groups and the default profile ones."
  },
  profileId: {
    ...nullableId,
    description: "The profile the group belongs to; refers to profiles.id. NULL when Safari records none, as for the pinned-tab folders shared by all profiles."
  },
  kind: {
    ...safariFields.text,
    enum: tabGroupKinds,
    description: "named: a tab group the user named; unnamed: a synced group of a window ordinary tabs; local and private: the window own groups of ordinary and private tabs; pinned and privatePinned: pinned tabs; recentlyClosed: tabs closed from tab groups; favorites: a group own Favorites; device: the folder of one device unnamed groups; special: another built-in folder."
  },
  title: {
    ...nullableText13,
    description: "Name as Safari stores it; NULL when absent."
  },
  position: {
    ...safariFields.integer,
    description: "Order within the containing folder."
  },
  hidden: {
    ...safariFields.boolean,
    description: "Whether Safari hides the group from its lists."
  },
  lastSelectedTabId: {
    ...nullableId,
    description: "The tab last shown in the group; refers to tabs.id. NULL when none."
  },
  deviceType: {
    ...nullableText13,
    description: "For a device folder, the Apple model identifier of the device; NULL otherwise."
  },
  topic: {
    ...nullableText13,
    description: "Topic Safari assigned to the group; NULL when none."
  },
  addedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the group was created; NULL when not recorded."
  },
  modifiedAt: {
    ...safariFields.nullableTimestamp,
    description: "When Safari last changed the group; NULL when not recorded."
  },
  closedAt: {
    ...safariFields.nullableTimestamp,
    description: "When the group was closed; NULL while open."
  }
};
var TabGroupsStream = class extends SafariStream {
  name = "tabGroups";
  store = "tabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per Safari tab group and tab folder (SafariTabs.db bookmarks folders other than profiles): named and unnamed groups, each window own groups, pinned tabs, and group Favorites. Relationships name streams in this source, not physical destination tables.",
    properties: properties18,
    required: Object.keys(properties18)
  };
  rows(scan) {
    return scan.tabs.tabGroups;
  }
  record(row, scan) {
    const { tabs } = scan;
    const [extra] = tabs.attributes(row);
    return {
      id: row.external_uuid,
      parentId: row.parent === 0 ? null : tabs.uuid(row.parent),
      profileId: tabs.profileOf(row),
      kind: tabs.kind(row),
      title: text(row.title),
      position: row.order_index,
      hidden: flag(row.hidden),
      lastSelectedTabId: tabs.uuid(row.last_selected_child),
      deviceType: text(extra.DeviceTypeIdentifier),
      topic: text(row.topic_title),
      addedAt: plistTime(dictionary(extra["com.apple.Bookmark"]).DateAdded),
      modifiedAt: appleTime(row.last_modified),
      closedAt: appleTime(row.date_closed)
    };
  }
};

// packages/sources/apple/safari/dist/streams/tab-history-entries-stream.js
var { nullableText: nullableText14 } = safariFields;
var properties19 = {
  tabId: { ...safariFields.id, description: "The tab; refers to tabs.id." },
  position: {
    ...safariFields.ordinal,
    description: "Index in the tab back and forward list, oldest first."
  },
  current: {
    ...safariFields.boolean,
    description: "Whether the tab shows this entry."
  },
  url: { ...nullableText14, description: "Page URL; NULL when absent." },
  originalUrl: {
    ...nullableText14,
    description: "URL first requested before redirects; NULL when absent."
  },
  title: { ...nullableText14, description: "Page title; NULL when absent." },
  scriptCreated: {
    ...safariFields.boolean,
    description: "Whether page script created the entry without user interaction."
  },
  externalUrlPolicy: {
    ...nullableText14,
    description: "Whether links from this entry may open other apps, as Safari stores it; NULL when absent."
  }
};
var TabHistoryEntriesStream = class extends SafariStream {
  name = "tabHistoryEntries";
  store = "tabs";
  primaryKey = ["tabId", "position"];
  jsonSchema = {
    type: "object",
    description: "One source record per page in a tab back and forward list (SafariTabs.db SessionState). Page form and scroll state are WebKit data and are not exported. Relationships name streams in this source, not physical destination tables.",
    properties: properties19,
    required: Object.keys(properties19)
  };
  rows(scan) {
    return scan.tabs.historyEntries();
  }
  record({ tab, entry, position, current }) {
    return {
      tabId: tab.external_uuid,
      position,
      current,
      url: text(entry.SessionHistoryEntryURL),
      originalUrl: text(entry.SessionHistoryEntryOriginalURL),
      title: text(entry.SessionHistoryEntryTitle),
      scriptCreated: flag(entry.SessionHistoryEntryWasCreatedByJSWithoutUserInteraction),
      externalUrlPolicy: text(entry.SessionHistoryEntryShouldOpenExternalURLsPolicyKey)
    };
  }
};

// packages/sources/apple/safari/dist/streams/tabs-stream.js
var { boolean: boolean8, nullableId: nullableId2, nullableText: nullableText15, nullableTimestamp: nullableTimestamp5 } = safariFields;
var properties20 = {
  id: {
    ...safariFields.id,
    description: "Tab UUID; tabHistoryEntries.tabId and windowTabGroups.activeTabId refer to it."
  },
  tabGroupId: {
    ...safariFields.id,
    description: "The group holding the tab; refers to tabGroups.id."
  },
  kind: {
    ...safariFields.text,
    enum: ["tab", "favorite"],
    description: "tab: an open tab; favorite: an entry of a tab group own Favorites."
  },
  profileId: {
    ...nullableId2,
    description: "The profile the tab belongs to; refers to profiles.id. NULL when Safari records none."
  },
  windowId: {
    ...nullableText15,
    description: "The window the tab was last shown in; windows.id while that window is saved. NULL when not recorded."
  },
  position: {
    ...safariFields.integer,
    description: "Order within the tab group."
  },
  tabIndex: {
    ...safariFields.nullableInteger,
    description: "Position in the window tab bar; NULL when not recorded."
  },
  title: { ...nullableText15, description: "Page title; NULL when absent." },
  url: { ...nullableText15, description: "Page URL; NULL for an empty tab." },
  localTitle: {
    ...nullableText15,
    description: "Title this Mac shows, when it differs from the synced one; NULL when absent."
  },
  localUrl: {
    ...nullableText15,
    description: "URL this Mac shows, when it differs from the synced one; NULL when absent."
  },
  pinned: { ...boolean8, description: "Whether the tab is pinned." },
  pinnedTitle: {
    ...nullableText15,
    description: "Title the pinned tab keeps; NULL for unpinned tabs."
  },
  pinnedUrl: {
    ...nullableText15,
    description: "Address the pinned tab returns to; NULL for unpinned tabs."
  },
  addedAt: {
    ...nullableTimestamp5,
    description: "When the tab was opened; NULL when not recorded."
  },
  lastViewedAt: {
    ...nullableTimestamp5,
    description: "When the tab was last shown; NULL when never."
  },
  lastVisitedAt: {
    ...nullableTimestamp5,
    description: "When the tab last loaded a page; NULL when never."
  },
  lastAccessedAt: {
    ...nullableTimestamp5,
    description: "When the tab was last accessed; NULL when never."
  },
  modifiedAt: {
    ...nullableTimestamp5,
    description: "When Safari last changed the tab; NULL when not recorded."
  },
  closedAt: {
    ...nullableTimestamp5,
    description: "When the tab was closed; NULL while open."
  },
  muted: { ...boolean8, description: "Whether the tab is muted." },
  showingReader: {
    ...boolean8,
    description: "Whether the tab shows the page in Reader."
  },
  readerScrollOffset: {
    ...safariFields.nullableNumber,
    description: "Reader scroll offset, in points; NULL when not recorded."
  },
  openedFromLink: {
    ...boolean8,
    description: "Whether the tab was opened from a link."
  },
  standaloneImage: {
    ...boolean8,
    description: "Whether the tab shows an image on its own."
  },
  disposable: {
    ...boolean8,
    description: "Safari IsDisposable flag as stored."
  },
  safeToLoad: { ...boolean8, description: "Safari SafeToLoad flag as stored." },
  ancestorTabIds: {
    type: "array",
    items: { type: "string" },
    description: "UUIDs of the tabs this tab was opened from, in stored order; empty when opened directly."
  },
  deviceId: {
    ...nullableText15,
    description: "Identifier of the device that opened the tab."
  },
  topic: {
    ...nullableText15,
    description: "Topic Safari assigned to the page; NULL when none."
  },
  pageLanguage: {
    ...nullableText15,
    description: "Language Safari detected for the page; NULL when none."
  },
  pageSummary: {
    ...nullableText15,
    description: "Summary Safari derived for the page; NULL when none."
  },
  pageKeywords: {
    type: "array",
    items: { type: "string" },
    description: "Keywords Safari derived for the page; empty when none."
  },
  pageKeywordWeights: {
    type: "array",
    items: { type: "number" },
    description: "Weight of each pageKeywords entry, in the same order."
  },
  featureText: {
    ...nullableText15,
    description: "Summary text Safari fetched for the page; NULL when none."
  }
};
var TabsStream = class extends SafariStream {
  name = "tabs";
  store = "tabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per tab Safari keeps in its tab store (SafariTabs.db): open tabs of every window and tab group, pinned tabs, and tab group Favorites. Relationships name streams in this source, not physical destination tables.",
    properties: properties20,
    required: Object.keys(properties20)
  };
  rows(scan) {
    return scan.tabs.tabs;
  }
  record(row, scan) {
    const { tabs } = scan;
    const [extra, local] = tabs.attributes(row);
    const context = dictionary(local.TabPageContextIDKey);
    const parent = tabs.row(row.parent);
    return {
      id: row.external_uuid,
      tabGroupId: tabs.uuid(row.parent),
      kind: parent !== void 0 && tabs.kind(parent) === "favorites" ? "favorite" : "tab",
      profileId: tabs.profileOf(row),
      windowId: text(local.WindowUUID),
      position: row.order_index,
      tabIndex: integer(local.TabIndex),
      title: text(row.title),
      url: text(row.url),
      localTitle: text(extra.LocalTitle),
      localUrl: text(extra.LocalURL),
      pinned: flag(extra.IsPinned) || flag(local.IsPinned),
      pinnedTitle: text(extra.PinnedTitle) ?? text(local.PinnedPageTitle),
      pinnedUrl: text(extra.PinnedAddress) ?? text(local.PinnedPageURL),
      addedAt: plistTime(dictionary(extra["com.apple.Bookmark"]).DateAdded),
      lastViewedAt: plistTime(extra.DateLastViewed),
      lastVisitedAt: plistTime(local.LastVisitTime),
      lastAccessedAt: plistTime(local.LastAccessDate),
      modifiedAt: appleTime(row.last_modified),
      closedAt: appleTime(row.date_closed) ?? plistTime(local.DateClosed),
      muted: flag(local.IsMuted),
      showingReader: flag(local.ShowingReader),
      readerScrollOffset: number(local.ReaderViewTopScrollOffset),
      openedFromLink: flag(local.OpenedFromLink),
      standaloneImage: flag(local.DisplayingStandaloneImage),
      disposable: flag(local.IsDisposable),
      safeToLoad: flag(local.SafeToLoad),
      ancestorTabIds: strings(local.AncestorTabUUIDsKey),
      deviceId: text(extra.DeviceIdentifier),
      topic: text(row.topic_title) ?? text(context.topicID),
      pageLanguage: text(context.pageLanguage),
      pageSummary: text(context.summary),
      pageKeywords: strings(context.keywords),
      pageKeywordWeights: list(context.keywordsWeights),
      featureText: text(extra.featureText)
    };
  }
};

// packages/sources/apple/safari/dist/streams/window-profiles-stream.js
var properties21 = {
  windowId: {
    ...safariFields.id,
    description: "The window; refers to windows.id."
  },
  profileId: {
    ...safariFields.id,
    description: "A profile the window has shown; refers to profiles.id."
  },
  activeTabGroupId: {
    ...safariFields.nullableId,
    description: "The tab group the window shows for that profile; refers to tabGroups.id."
  }
};
var WindowProfilesStream = class extends SafariStream {
  name = "windowProfiles";
  store = "tabs";
  primaryKey = ["windowId", "profileId"];
  jsonSchema = {
    type: "object",
    description: "One source record per profile a window remembers, with the tab group it shows for it (SafariTabs.db windows_profiles). Relationships name streams in this source, not physical destination tables.",
    properties: properties21,
    required: Object.keys(properties21)
  };
  rows(scan) {
    return scan.tabs.windowProfiles;
  }
  record(row, scan) {
    const { tabs } = scan;
    return {
      windowId: tabs.windowUuid(row.window_id),
      profileId: tabs.uuid(row.profile_id),
      activeTabGroupId: tabs.uuid(row.active_tab_group_id)
    };
  }
};

// packages/sources/apple/safari/dist/streams/window-tab-groups-stream.js
var properties22 = {
  windowId: {
    ...safariFields.id,
    description: "The window; refers to windows.id."
  },
  tabGroupId: {
    ...safariFields.id,
    description: "A tab group of the window; refers to tabGroups.id."
  },
  activeTabId: {
    ...safariFields.nullableId,
    description: "The tab the window shows in that group; refers to tabs.id. NULL when not recorded."
  },
  unnamed: {
    ...safariFields.boolean,
    description: "Whether the group is one of the window unnamed tab groups."
  }
};
var WindowTabGroupsStream = class extends SafariStream {
  name = "windowTabGroups";
  store = "tabs";
  primaryKey = ["windowId", "tabGroupId"];
  jsonSchema = {
    type: "object",
    description: "One source record per tab group a window holds or has shown, with its active tab (SafariTabs.db windows_tab_groups and windows_unnamed_tab_groups). Relationships name streams in this source, not physical destination tables.",
    properties: properties22,
    required: Object.keys(properties22)
  };
  rows(scan) {
    return scan.tabs.windowTabGroups;
  }
  record(row, scan) {
    const { tabs } = scan;
    return {
      windowId: tabs.windowUuid(row.window_id),
      tabGroupId: tabs.uuid(row.tab_group_id),
      activeTabId: tabs.uuid(row.active_tab_id),
      unnamed: flag(row.unnamed)
    };
  }
};

// packages/sources/apple/safari/dist/streams/windows-stream.js
var { nullableId: nullableId3, nullableText: nullableText16 } = safariFields;
var properties23 = {
  id: {
    ...safariFields.id,
    description: "Window UUID; tabs.windowId, windowTabGroups.windowId and windowProfiles.windowId refer to it."
  },
  profileId: {
    ...nullableId3,
    description: "The profile the window shows; refers to profiles.id. NULL when not recorded."
  },
  activeTabGroupId: {
    ...nullableId3,
    description: "The tab group the window shows; refers to tabGroups.id."
  },
  localTabGroupId: {
    ...nullableId3,
    description: "The window own unnamed tab group of ordinary tabs; refers to tabGroups.id."
  },
  privateTabGroupId: {
    ...nullableId3,
    description: "The window own group of private tabs; refers to tabGroups.id."
  },
  lastSession: {
    ...safariFields.boolean,
    description: "Whether the window belongs to the last saved session."
  },
  sceneId: {
    ...nullableText16,
    description: "Scene identifier of the window; NULL when not recorded."
  },
  ...windowStateFields
};
var WindowsStream = class extends SafariStream {
  name = "windows";
  store = "tabs";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One source record per Safari window in the saved session (SafariTabs.db windows), with its state as Safari last saved it. Relationships name streams in this source, not physical destination tables.",
    properties: properties23,
    required: Object.keys(properties23)
  };
  rows(scan) {
    return scan.tabs.windows;
  }
  record(row, scan) {
    const { tabs } = scan;
    const state = windowState(tabs.windowState(row));
    return {
      id: row.uuid,
      profileId: tabs.uuid(row.active_profile_id),
      activeTabGroupId: tabs.uuid(row.active_tab_group_id),
      localTabGroupId: tabs.uuid(row.local_tab_group_id),
      privateTabGroupId: tabs.uuid(row.private_tab_group_id),
      lastSession: flag(row.is_last_session),
      sceneId: text(row.scene_id),
      ...state,
      closedAt: appleTime(row.date_closed) ?? state.closedAt
    };
  }
};

// packages/sources/apple/safari/dist/apple-safari-source.js
var readers = {
  historyItems: new HistoryItemsStream(),
  historyVisits: new HistoryVisitsStream(),
  historyTombstones: new HistoryTombstonesStream(),
  historyTags: new HistoryTagsStream(),
  historyItemTags: new HistoryItemTagsStream(),
  profiles: new ProfilesStream(),
  profileStartPageSections: new ProfileStartPageSectionsStream(),
  windows: new WindowsStream(),
  windowProfiles: new WindowProfilesStream(),
  windowTabGroups: new WindowTabGroupsStream(),
  tabGroups: new TabGroupsStream(),
  tabs: new TabsStream(),
  tabHistoryEntries: new TabHistoryEntriesStream(),
  cloudTabDevices: new CloudTabDevicesStream(),
  cloudTabs: new CloudTabsStream(),
  cloudTabPositions: new CloudTabPositionsStream(),
  cloudTabCloseRequests: new CloudTabCloseRequestsStream(),
  bookmarks: new BookmarksStream(),
  readingListItems: new ReadingListItemsStream(),
  closedWindows: new ClosedWindowsStream(),
  closedWindowActiveTabs: new ClosedWindowActiveTabsStream(),
  closedTabs: new ClosedTabsStream(),
  downloads: new DownloadsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
function readerOf(stream) {
  const reader = readersByName.get(stream.name);
  if (reader === void 0)
    throw new TypeError(`Safari has no ${stream.name} stream`);
  return reader;
}
var pollIntervalMs = 1e3;
var AppleSafariSource = class extends Source {
  identity;
  catalog = catalog;
  historyItems = readers.historyItems.describe();
  historyVisits = readers.historyVisits.describe();
  historyTombstones = readers.historyTombstones.describe();
  historyTags = readers.historyTags.describe();
  historyItemTags = readers.historyItemTags.describe();
  profiles = readers.profiles.describe();
  profileStartPageSections = readers.profileStartPageSections.describe();
  windows = readers.windows.describe();
  windowProfiles = readers.windowProfiles.describe();
  windowTabGroups = readers.windowTabGroups.describe();
  tabGroups = readers.tabGroups.describe();
  tabs = readers.tabs.describe();
  tabHistoryEntries = readers.tabHistoryEntries.describe();
  cloudTabDevices = readers.cloudTabDevices.describe();
  cloudTabs = readers.cloudTabs.describe();
  cloudTabPositions = readers.cloudTabPositions.describe();
  cloudTabCloseRequests = readers.cloudTabCloseRequests.describe();
  bookmarks = readers.bookmarks.describe();
  readingListItems = readers.readingListItems.describe();
  closedWindows = readers.closedWindows.describe();
  closedWindowActiveTabs = readers.closedWindowActiveTabs.describe();
  closedTabs = readers.closedTabs.describe();
  downloads = readers.downloads.describe();
  location;
  scope;
  constructor({ directory = safariDirectory, container = safariContainer, scope = {} } = {}) {
    super();
    this.location = Object.freeze({ directory, container });
    this.scope = scope;
    this.identity = `apple-safari:${directory}:${container}`;
    Object.freeze(this);
  }
  open(streams) {
    return SafariScan.open(this.location, new Set(streams.map((stream) => readerOf(stream).store)), this.scope);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  // Databases report commits through data_version; Safari rewrites each
  // property list whole, so a changed stat marks a new one.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const files = storeFiles(this.location);
      const stores = [
        ...new Set(streams.map((stream) => readerOf(stream).store))
      ];
      const versions = __using(_stack, new DisposableStack());
      const opened = /* @__PURE__ */ new Map();
      const version = (path) => {
        let found = opened.get(path);
        if (found === void 0) {
          found = versions.use(new SafariDatabaseVersion(path));
          opened.set(path, found);
        }
        return found.current;
      };
      const probes = new Map(stores.map((store) => {
        if (store === "history")
          return [
            store,
            async () => (await historyFiles(this.location)).map(version).join(",")
          ];
        if (!databaseStores.has(store))
          return [store, () => fingerprint(files[store])];
        return [store, async () => String(version(files[store]))];
      }));
      const seen = /* @__PURE__ */ new Map();
      for (const [store, probe] of probes)
        seen.set(store, await probe());
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          const changed = /* @__PURE__ */ new Set();
          for (const [store, probe] of probes) {
            const current = await probe();
            if (current === seen.get(store))
              continue;
            seen.set(store, current);
            changed.add(store);
          }
          if (changed.size > 0)
            yield streams.filter((stream) => changed.has(readerOf(stream).store));
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          throw error;
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      __callDispose(_stack, _error, _hasError);
    }
  }
  async *extract(configuration, state, _partition, scan) {
    const { stream } = configuration;
    const reader = readerOf(stream);
    const records = await reader.read(scan);
    const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ("type" in message || configuration.fileReads.length === 0)
        yield message;
      else
        yield { ...message, file: reader.file(message.data, scan) };
    }
  }
};
async function historyFiles(location) {
  const profiles = join3(location.container, "Profiles");
  const found = await readdir(profiles, { withFileTypes: true }).catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  });
  const others = await Promise.all(found.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const path = join3(profiles, entry.name, "History.db");
    return await fingerprint(path) === "missing" ? [] : [path];
  }));
  return [storeFiles(location).history, ...others.flat()];
}
async function fingerprint(path) {
  try {
    const { ino, size, mtimeMs } = await stat(path);
    return `${ino}:${size}:${mtimeMs}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return "missing";
    throw error;
  }
}

// packages/connectors/apple/safari/dist/safari-connector.js
var SafariConnector = class extends AppleConnector {
  datedBy = "visit time";
  fullDiskAccess = true;
  note = "Profiles select history, windows, tab groups, tabs, recently closed tabs and downloads. Dates select history visits, and the pages and topics those visits reach.";
  choices = [
    {
      stream: "profiles",
      scope: "collectionIds",
      title: "profiles",
      id: byId,
      // Safari stores no name for the profile it starts with.
      label: (row) => String(row.title ?? "Default profile")
    }
  ];
  // Bookmarks, the Reading List and iCloud Tabs belong to no profile or date.
  unscoped = [
    "bookmarks",
    "readingListItems",
    "cloudTabDevices",
    "cloudTabs",
    "cloudTabPositions",
    "cloudTabCloseRequests"
  ];
  storeCopies = [];
  access() {
    return "Open Safari to let it fetch history and tabs from your other devices.";
  }
  source(scope) {
    return new AppleSafariSource({ scope });
  }
};
export {
  SafariConnector as default
};
