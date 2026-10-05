import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  decodeArchive,
  plistJSON
} from "../../chunks/chunk-YLKLHO7E.mjs";
import {
  ProtobufMessage
} from "../../chunks/chunk-YYZPWRZX.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-7XFLCHNF.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffGroupedSnapshot,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-C5AZWDBZ.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/activity/dist/apple-activity-source.js
import { setInterval } from "node:timers/promises";

// packages/sources/apple/activity/dist/activity-scan.js
import { readdir } from "node:fs/promises";

// packages/sources/apple/activity/dist/activity-store.js
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var defaultActivityLocation = Object.freeze({
  biome: join(homedir(), "Library/Biome"),
  knowledge: join(homedir(), "Library/Application Support/Knowledge/knowledgeC.db")
});
var biomeStreams = ({ biome }) => join(biome, "streams/restricted");
var biomeDevices = ({ biome }) => join(biome, "sync/sync.db");
var ActivityUnavailableError = class extends Error {
  name = "ActivityUnavailableError";
  constructor(path, cause) {
    super(`Activity data at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`, { cause });
  }
};
var ActivitySchemaError = class extends Error {
  name = "ActivitySchemaError";
  constructor(path, missing) {
    super(`The activity store at ${path} has a layout this connector does not read (missing ${missing.join(", ")}).`);
  }
};
var unavailableCodes = /* @__PURE__ */ new Set([14, 23]);
var open = (path) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (cause instanceof Error && "errcode" in cause && unavailableCodes.has(Number(cause.errcode)))
      throw new ActivityUnavailableError(path, cause);
    throw cause;
  }
};
var ActivityDatabaseVersion = class {
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
var ActivityDatabase = class _ActivityDatabase {
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
        throw new ActivitySchemaError(path, missing);
      return new _ActivityDatabase(path, database);
    } catch (cause) {
      database.close();
      throw cause;
    }
  }
  all(sql, ...parameters) {
    return this.#database.prepare(sql).all(...parameters);
  }
  async [Symbol.asyncDispose]() {
    if (this.#database.isTransaction)
      this.#database.exec("COMMIT");
    this.#database.close();
  }
};

// packages/sources/apple/activity/dist/activity-scan.js
var knowledgeColumns = {
  ZOBJECT: [
    "Z_PK",
    "ZUUID",
    "ZSTREAMNAME",
    "ZSTARTDATE",
    "ZENDDATE",
    "ZCREATIONDATE",
    "ZSECONDSFROMGMT",
    "ZVALUESTRING",
    "ZVALUEINTEGER",
    "ZSTRUCTUREDMETADATA",
    "ZSOURCE"
  ],
  ZSTRUCTUREDMETADATA: [
    "Z_PK",
    "Z_DKINTENTMETADATAKEY__INTENTCLASS",
    "Z_DKINTENTMETADATAKEY__INTENTVERB",
    "Z_DKINTENTMETADATAKEY__INTENTTYPE",
    "Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS",
    "Z_DKINTENTMETADATAKEY__DIRECTION",
    "Z_DKINTENTMETADATAKEY__DONATEDBYSIRI",
    "Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER",
    "Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER",
    "Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS",
    "Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION",
    "Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD",
    "Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO"
  ],
  ZSOURCE: ["Z_PK", "ZBUNDLEID", "ZDEVICEID", "ZITEMID", "ZGROUPID"]
};
var deviceColumns = {
  DevicePeer: [
    "device_identifier",
    "me",
    "name",
    "model",
    "platform",
    "last_sync_date"
  ]
};
var ActivityScan = class _ActivityScan {
  startedAt;
  #resources;
  #stores;
  constructor(startedAt, resources, stores) {
    this.startedAt = startedAt;
    this.#resources = resources;
    this.#stores = stores;
  }
  static async open(location, stores) {
    var _stack = [];
    try {
      const startedAt = /* @__PURE__ */ new Date();
      const resources = __using(_stack, new AsyncDisposableStack(), true);
      const open3 = async (store, value) => {
        if (!stores.has(store))
          return void 0;
        try {
          return { value: await value() };
        } catch (error) {
          return { error };
        }
      };
      const opened = {
        // Each stream lists its own segments; this proves the folder is readable.
        biome: await open3("biome", async () => {
          const root = biomeStreams(location);
          try {
            await readdir(root);
          } catch (cause) {
            throw new ActivityUnavailableError(root, cause);
          }
          return root;
        }),
        knowledge: await open3("knowledge", async () => resources.use(await ActivityDatabase.open(location.knowledge, knowledgeColumns))),
        devices: await open3("devices", async () => resources.use(await ActivityDatabase.open(biomeDevices(location), deviceColumns)))
      };
      return new _ActivityScan(startedAt, resources.move(), opened);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
  // The folder holding every Biome stream.
  get biome() {
    return this.#value("biome");
  }
  get knowledge() {
    return this.#value("knowledge");
  }
  get devices() {
    return this.#value("devices");
  }
  #value(store) {
    const opened = this.#stores[store];
    if (opened === void 0)
      throw new Error(`Activity ${store} was not opened for this run`);
    if ("error" in opened)
      throw opened.error;
    return opened.value;
  }
  [Symbol.asyncDispose]() {
    return this.#resources.disposeAsync();
  }
};

// packages/sources/apple/activity/dist/biome-stream.js
import { readdir as readdir2 } from "node:fs/promises";
import { join as join2 } from "node:path";

// packages/macos/segb/dist/segb.js
import { createHash } from "node:crypto";
import { open as open2, readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
var headerLength = 32;
var entryHeaderLength = 8;
var slotLength = 16;
var appleEpoch = Date.UTC(2001, 0, 1);
var SegbFormatError = class extends Error {
  name = "SegbFormatError";
  constructor(path, problem) {
    super(`${path} is not a SEGB v2 file: ${problem}`);
  }
};
var states = /* @__PURE__ */ new Map([
  [1, "written"],
  [3, "deleted"]
]);
async function segbFingerprint(path) {
  var _stack = [];
  try {
    const file = __using(_stack, await open2(path), true);
    const header = new Uint8Array(headerLength);
    const { size } = await file.stat();
    await file.read(header, 0, headerLength, 0);
    const count = slotCount(path, header, size);
    const trailer = new Uint8Array(count * slotLength);
    await file.read(trailer, 0, trailer.length, size - trailer.length);
    return createHash("sha256").update(trailer).digest("base64url");
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    var _promise = __callDispose(_stack, _error, _hasError);
    _promise && await _promise;
  }
}
async function readSegb(path) {
  const bytes = await readFile(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = slotCount(path, bytes, bytes.length);
  const trailer = bytes.length - count * slotLength;
  const records = [];
  let start = headerLength;
  for (let slot = 0; slot < count; slot++) {
    const at = bytes.length - slotLength * (slot + 1);
    const end = headerLength + view.getInt32(at, true);
    const state = states.get(view.getInt32(at + 4, true));
    if (end > trailer)
      throw new SegbFormatError(path, `slot ${slot} ends inside the trailer`);
    if (state !== void 0) {
      const data = end - start >= entryHeaderLength ? bytes.subarray(start + entryHeaderLength, end) : null;
      records.push({
        slot,
        state,
        writtenAt: new Date(appleEpoch + view.getFloat64(at + 8, true) * 1e3),
        payload: state === "written" && data !== null && crc32(data) === view.getUint32(start, true) ? data : null
      });
    }
    if (end > start)
      start = end + (4 - end % 4) % 4;
  }
  return records;
}
function slotCount(path, header, size) {
  if (size < headerLength || new TextDecoder("latin1").decode(header.subarray(0, 4)) !== "SEGB")
    throw new SegbFormatError(path, "no SEGB header");
  const count = new DataView(header.buffer, header.byteOffset, header.length).getInt32(4, true);
  if (count < 0 || headerLength + count * slotLength > size)
    throw new SegbFormatError(path, `a trailer of ${count} slots does not fit`);
  return count;
}

// packages/sources/apple/activity/dist/activity-values.js
var text = { type: "string" };
var nullableText = { type: ["string", "null"] };
var activityFields = {
  text,
  nullableText,
  integer: { type: "integer" },
  nullableInteger: { type: ["integer", "null"] },
  number: { type: "number" },
  boolean: { type: "boolean" },
  nullableBoolean: { type: ["boolean", "null"] },
  timestamp: { ...text, format: "date-time" },
  nullableTimestamp: { ...nullableText, format: "date-time" },
  bundleId: {
    ...text,
    minLength: 1,
    description: "Bundle identifier of the app, such as com.apple.Safari."
  }
};
var appleEpochSeconds = 978307200;
var instant = (seconds) => new Date(Math.round(seconds * 1e3)).toISOString();
var finite = (value) => typeof value === "number" && Number.isFinite(value);
var appleTime = (value) => finite(value) ? instant(value + appleEpochSeconds) : null;
var unixTime = (value) => finite(value) ? instant(value) : null;
var nonEmpty = (value) => typeof value === "string" && value !== "" ? value : null;
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
var flag = (value) => typeof value === "number" ? value !== 0 : null;
var dayMs = 864e5;
var marginMs = 36e5;
var retainedSince = (startedAt, retentionDays) => new Date(startedAt.getTime() - retentionDays * dayMs + marginMs).toISOString();
var archiveJSON = (value) => value instanceof Uint8Array && value.length > 0 ? plistJSON(decodeArchive(value)) : null;

// packages/sources/apple/activity/dist/biome-stream.js
var parserVersion = 1;
var biomeAddress = {
  origin: {
    type: "string",
    minLength: 1,
    description: "Where the record was written: 'local' for this Mac, otherwise the identifier of the synced device it came from (devices.deviceId when Biome lists the device)."
  },
  segment: {
    type: "string",
    minLength: 1,
    description: "The Biome segment file holding the record, named for when the writing device started it, in microseconds since 2001-01-01."
  },
  slot: {
    type: "integer",
    minimum: 0,
    description: "The record's place in its segment, 0 for the first. With origin and segment it identifies the record."
  },
  recordedAt: {
    type: "string",
    format: "date-time",
    description: "When Biome wrote the record. macOS drops records once they pass the stream\u2019s maximum age; the row stays loaded."
  },
  payload: {
    type: "string",
    description: "The record's protobuf exactly as Biome stores it, base64. Biome's format is private: fields this stream does not name stay readable here."
  }
};
async function segments(root, biomeName) {
  const files = async (origin, directory) => (await entries(directory)).filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => ({
    origin,
    name: entry.name,
    path: join2(directory, entry.name)
  }));
  const stream = join2(root, biomeName);
  const devices = (await entries(join2(stream, "remote"))).filter((entry) => entry.isDirectory());
  return [
    ...await files("local", join2(stream, "local")),
    ...(await Promise.all(devices.map((device) => files(device.name, join2(stream, "remote", device.name))))).flat()
  ];
}
async function entries(directory) {
  try {
    return await readdir2(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return [];
    throw new ActivityUnavailableError(directory, cause);
  }
}
var segmentFingerprint = async (segment) => `${parserVersion}:${await segbFingerprint(segment.path)}`;
var BiomeStream = class {
  store = "biome";
  primaryKey = Object.freeze([
    "origin",
    "segment",
    "slot"
  ]);
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  sourceDefinedCursor = true;
  emitsDeletes = true;
  expiresBy = "recordedAt";
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  // Incremental copies read only the segments whose trailer changed, and keep
  // the rows of records macOS expired.
  async *messages(configuration, state, scan) {
    const found = await segments(scan.biome, this.biomeName);
    if (configuration.syncMode === "full_refresh") {
      for (const segment of found)
        for await (const data of this.#read(segment))
          yield { stream: this.name, data };
      return;
    }
    const groups = await Promise.all(found.map(async (segment) => ({
      key: `${segment.origin}/${segment.name}`,
      fingerprint: await segmentFingerprint(segment),
      records: () => this.#read(segment)
    })));
    yield* diffGroupedSnapshot(configuration.stream, groups, state, retainedSince(scan.startedAt, this.retentionDays));
  }
  async *#read(segment) {
    const drafts = (await readSegb(segment.path)).flatMap((record) => record.payload === null ? [] : [
      this.record(new ProtobufMessage(record.payload), {
        origin: segment.origin,
        segment: segment.name,
        slot: record.slot,
        recordedAt: record.writtenAt.toISOString(),
        payload: Buffer.from(record.payload).toString("base64")
      })
    ]);
    yield* validateRecords(this, drafts, "Activity");
  }
};

// packages/sources/apple/activity/dist/streams/app-focus-stream.js
var { nullableText: nullableText2, nullableInteger, nullableBoolean } = activityFields;
var properties = {
  ...biomeAddress,
  started: {
    ...activityFields.boolean,
    description: "Whether the app came into focus (true) or left it (false). One switch writes an end for the app left and a start for the app entered, at the same instant."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When the focus changed, as the event states it."
  },
  bundleId: activityFields.bundleId,
  launchReason: {
    ...nullableText2,
    description: "Why the app came forward on an iPhone, such as com.apple.SpringBoard.transitionReason.appswitcher; NULL on a Mac."
  },
  eventType: {
    ...activityFields.integer,
    description: "Biome focus event type as stored (1 observed on a Mac)."
  },
  shortVersion: {
    ...nullableText2,
    description: "The app's version (CFBundleShortVersionString)."
  },
  bundleVersion: {
    ...nullableText2,
    description: "The app's build (CFBundleVersion)."
  },
  platform: {
    ...nullableInteger,
    description: "The app's dyld platform: 1 macOS, 6 Mac Catalyst; NULL when not recorded, as on an iPhone."
  },
  nativeArchitecture: {
    ...nullableBoolean,
    description: "Whether the app ran natively rather than under Rosetta; NULL when not recorded."
  },
  displayType: {
    ...nullableInteger,
    description: "Biome display type as stored."
  }
};
var AppFocusStream = class extends BiomeStream {
  name = "appFocus";
  biomeName = "App.InFocus";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per app focus change (Biome App.InFocus) on this Mac and the devices it syncs with: an app coming into the foreground, or leaving it. A session runs from a start to the next end of the same app and origin.",
    properties,
    required: Object.keys(properties)
  };
  record(payload, address) {
    return {
      ...address,
      started: flag(payload.uint(3)),
      occurredAt: appleTime(payload.double(4)),
      bundleId: payload.string(6),
      launchReason: nonEmpty(payload.string(1)),
      eventType: integer(payload.uint(2)),
      shortVersion: nonEmpty(payload.string(9)),
      bundleVersion: nonEmpty(payload.string(10)),
      platform: integer(payload.uint(11)),
      nativeArchitecture: flag(payload.uint(12)),
      displayType: integer(payload.uint(13))
    };
  }
};

// packages/sources/apple/activity/dist/streams/app-intents-stream.js
var { text: text2, integer: integerField, nullableText: nullableText3 } = activityFields;
var properties2 = {
  ...biomeAddress,
  occurredAt: {
    ...activityFields.timestamp,
    description: "When the interaction happened, in whole seconds; it can precede recordedAt."
  },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app that donated the interaction."
  },
  sourceId: { ...text2, description: "Biome intent source as stored." },
  intentClass: {
    ...text2,
    description: "SiriKit intent class, such as INSendMessageIntent."
  },
  intentVerb: {
    ...text2,
    description: "SiriKit intent verb, such as SendMessage."
  },
  intentType: { ...integerField, description: "Biome intent type as stored." },
  handlingStatus: {
    ...integerField,
    description: "INIntentHandlingStatus as stored."
  },
  direction: {
    ...integerField,
    description: "Interaction direction as Biome stores it (1, 2 and 3 observed, mostly 3); knowledgeIntents.direction holds the INInteractionDirection value."
  },
  donatedBySiri: {
    ...activityFields.boolean,
    description: "Whether Siri donated the interaction rather than the app."
  },
  itemId: {
    ...text2,
    description: "Identifier of the donated item, a UUID."
  },
  groupId: {
    ...nullableText3,
    description: "Group the interaction belongs to, such as a conversation; NULL when the app gave none."
  },
  interaction: {
    ...nullableText3,
    description: "The donated INInteraction, decoded from its keyed archive to JSON: its intent, response, date interval and participants."
  }
};
var AppIntentsStream = class extends BiomeStream {
  name = "appIntents";
  biomeName = "App.Intent";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per interaction an app donated to the system on this Mac (Biome App.Intent), such as a message sent or received through a messaging app.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  record(payload, address) {
    return {
      ...address,
      occurredAt: appleTime(payload.double(1)),
      bundleId: payload.string(2),
      sourceId: payload.string(3),
      intentClass: payload.string(4),
      intentVerb: payload.string(5),
      intentType: integer(payload.uint(6)),
      handlingStatus: integer(payload.uint(7)),
      direction: integer(payload.uint(11)),
      donatedBySiri: flag(payload.uint(10)),
      itemId: payload.string(9),
      groupId: nonEmpty(payload.string(12)),
      interaction: archiveJSON(payload.bytes(8))
    };
  }
};

// packages/sources/apple/activity/dist/streams/app-menu-items-stream.js
var properties3 = {
  ...biomeAddress,
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app whose menu was used."
  }
};
var AppMenuItemsStream = class extends BiomeStream {
  name = "appMenuItems";
  biomeName = "App.MenuItem";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per use of an app's menu bar on this Mac (Biome App.MenuItem). Biome records which app, not which item.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  record(payload, address) {
    return { ...address, bundleId: payload.string(1) };
  }
};

// packages/sources/apple/activity/dist/streams/bluetooth-connections-stream.js
var { integer: integerField2 } = activityFields;
var battery = (part) => ({
  ...integerField2,
  minimum: 0,
  maximum: 100,
  description: `Battery of the ${part}, percent (0 when not reported).`
});
var properties4 = {
  ...biomeAddress,
  address: {
    ...activityFields.text,
    description: "Bluetooth address of the device."
  },
  deviceName: {
    ...activityFields.nullableText,
    description: "Name of the device; NULL when it had none."
  },
  connected: {
    ...activityFields.boolean,
    description: "Whether the device connected (true) or disconnected (false)."
  },
  vendorId: {
    ...integerField2,
    description: "Bluetooth vendor ID, such as 76 for Apple."
  },
  productId: { ...integerField2, description: "Bluetooth product ID." },
  deviceType: {
    ...integerField2,
    description: "Bluetooth device type as stored."
  },
  appleAudioDevice: {
    ...activityFields.boolean,
    description: "Whether it is Apple audio, such as AirPods."
  },
  userWearing: {
    ...activityFields.boolean,
    description: "Whether the user wore it, for headphones."
  },
  batteryCase: battery("headphone case"),
  batteryLeft: battery("left headphone"),
  batteryRight: battery("right headphone")
};
var BluetoothConnectionsStream = class extends BiomeStream {
  name = "bluetoothConnections";
  biomeName = "Device.Wireless.Bluetooth";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per Bluetooth device connecting or disconnecting on this Mac and the devices it syncs with (Biome Device.Wireless.Bluetooth).",
    properties: properties4,
    required: Object.keys(properties4)
  };
  record(payload, address) {
    return {
      ...address,
      address: payload.string(1),
      deviceName: nonEmpty(payload.string(2)),
      connected: flag(payload.uint(4)),
      vendorId: integer(payload.uint(11)),
      productId: integer(payload.uint(3)),
      deviceType: integer(payload.uint(5)),
      appleAudioDevice: flag(payload.uint(9)),
      userWearing: flag(payload.uint(10)),
      batteryCase: integer(payload.uint(6)),
      batteryLeft: integer(payload.uint(8)),
      batteryRight: integer(payload.uint(7))
    };
  }
};

// packages/sources/apple/activity/dist/streams/devices-stream.js
var { nullableText: nullableText4, nullableInteger: nullableInteger2 } = activityFields;
var properties5 = {
  deviceId: {
    ...activityFields.text,
    minLength: 1,
    description: "Biome identifier of the device; origin in the Biome streams refers to it."
  },
  thisMac: {
    ...activityFields.boolean,
    description: "Whether it is this Mac, whose records carry origin 'local'."
  },
  name: {
    ...nullableText4,
    description: "Name of the device; Biome usually leaves it empty (NULL)."
  },
  model: {
    ...nullableText4,
    description: "What Biome stores as the model, an OS build such as 23G90. The column is numeric, so a build that reads as a number arrives mangled."
  },
  platform: {
    ...nullableInteger2,
    description: "Biome device platform as stored: 2 iPhone, 3 Mac desktop, 4 Mac portable, 5 TV observed."
  },
  lastSyncedAt: {
    ...activityFields.nullableTimestamp,
    description: "When Biome last synced with the device; NULL for this Mac."
  }
};
var DevicesStream = class {
  store = "devices";
  name = "devices";
  retentionDays = null;
  primaryKey = Object.freeze(["deviceId"]);
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  sourceDefinedCursor = true;
  emitsDeletes = true;
  jsonSchema = {
    type: "object",
    description: "One source record per device Biome syncs activity with, this Mac included (Biome sync.db DevicePeer).",
    properties: properties5,
    required: Object.keys(properties5)
  };
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async *messages(configuration, state, scan) {
    const records = this.#read(scan);
    if (configuration.syncMode === "full_refresh")
      yield* records.map((data) => ({ stream: this.name, data }));
    else
      yield* diffSnapshot(configuration.stream, records, state);
  }
  #read(scan) {
    return validateRecords(this, scan.devices.all("SELECT device_identifier, me, name, CAST(model AS TEXT) AS model, platform, last_sync_date FROM DevicePeer ORDER BY device_identifier").map((row) => this.#record(row)), "Activity");
  }
  #record(row) {
    return {
      deviceId: row.device_identifier,
      thisMac: row.me === 1,
      name: nonEmpty(row.name),
      model: nonEmpty(row.model),
      platform: integer(row.platform),
      lastSyncedAt: unixTime(row.last_sync_date)
    };
  }
};

// packages/sources/apple/activity/dist/knowledge-stream.js
var knowledgeEvent = {
  id: {
    ...activityFields.text,
    minLength: 1,
    description: "knowledgeC event identifier (ZOBJECT.ZUUID)."
  },
  startedAt: {
    ...activityFields.timestamp,
    description: "When the event started. macOS drops events once they pass the stream\u2019s maximum age; the row stays loaded."
  },
  endedAt: {
    ...activityFields.timestamp,
    description: "When the event ended."
  },
  createdAt: {
    ...activityFields.timestamp,
    description: "When knowledgeC stored the event."
  },
  utcOffsetSeconds: {
    ...activityFields.integer,
    description: "The device\u2019s offset from UTC when the event happened."
  }
};
var eventColumns = "o.ZUUID, o.ZSTARTDATE, o.ZENDDATE, o.ZCREATIONDATE, o.ZSECONDSFROMGMT";
var KnowledgeStream = class {
  store = "knowledge";
  primaryKey = Object.freeze(["id"]);
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  sourceDefinedCursor = true;
  emitsDeletes = true;
  expiresBy = "startedAt";
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async *messages(configuration, state, scan) {
    const records = this.#read(scan);
    if (configuration.syncMode === "full_refresh")
      yield* records.map((data) => ({ stream: this.name, data }));
    else
      yield* diffSnapshot(configuration.stream, records, state, retainedSince(scan.startedAt, this.retentionDays));
  }
  #read(scan) {
    const rows = scan.knowledge.all(`SELECT ${eventColumns}, ${this.columns}
       FROM ZOBJECT o
       LEFT JOIN ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA
       LEFT JOIN ZSOURCE s ON s.Z_PK = o.ZSOURCE
       WHERE o.ZSTREAMNAME = ? ORDER BY o.Z_PK`, this.streamName);
    return validateRecords(this, rows.map((row) => this.record(row)), "Activity");
  }
};

// packages/sources/apple/activity/dist/streams/discoverability-signals-stream.js
var { nullableText: nullableText5 } = activityFields;
var properties6 = {
  ...knowledgeEvent,
  signal: {
    ...nullableText5,
    description: "The event the signal reports, such as com.apple.spotlight.invoked."
  },
  bundleId: {
    ...nullableText5,
    description: "Bundle identifier of the app that reported the signal."
  },
  osBuild: {
    ...nullableText5,
    description: "macOS build that recorded the signal."
  },
  userInfo: {
    ...nullableText5,
    description: "Extra data the signal carried, decoded from its property list to JSON; NULL when none."
  }
};
var DiscoverabilitySignalsStream = class extends KnowledgeStream {
  name = "discoverabilitySignals";
  streamName = "/discoverability/signals";
  retentionDays = 730;
  jsonSchema = {
    type: "object",
    description: "One source record per feature-discovery signal on this Mac (knowledgeC /discoverability/signals), the events macOS uses to time its tips. macOS keeps these for two years.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  columns = `o.ZVALUESTRING, s.ZBUNDLEID,
    m.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD, m.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO`;
  record(row) {
    return {
      id: row.ZUUID,
      startedAt: appleTime(row.ZSTARTDATE),
      endedAt: appleTime(row.ZENDDATE),
      createdAt: appleTime(row.ZCREATIONDATE),
      utcOffsetSeconds: row.ZSECONDSFROMGMT,
      signal: nonEmpty(row.ZVALUESTRING),
      bundleId: nonEmpty(row.ZBUNDLEID),
      osBuild: nonEmpty(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD),
      userInfo: archiveJSON(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO)
    };
  }
};

// packages/sources/apple/activity/dist/streams/display-backlight-stream.js
var properties7 = {
  ...knowledgeEvent,
  backlit: {
    ...activityFields.boolean,
    description: "Whether the display was lit between startedAt and endedAt (false: off or asleep)."
  }
};
var DisplayBacklightStream = class extends KnowledgeStream {
  name = "displayBacklight";
  streamName = "/display/isBacklit";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per span the display stayed lit or dark on this Mac (knowledgeC /display/isBacklit): when the screen was on.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  columns = "o.ZVALUEINTEGER";
  record(row) {
    return {
      id: row.ZUUID,
      startedAt: appleTime(row.ZSTARTDATE),
      endedAt: appleTime(row.ZENDDATE),
      createdAt: appleTime(row.ZCREATIONDATE),
      utcOffsetSeconds: row.ZSECONDSFROMGMT,
      backlit: flag(row.ZVALUEINTEGER)
    };
  }
};

// packages/sources/apple/activity/dist/streams/document-interactions-stream.js
var { text: text3 } = activityFields;
var properties8 = {
  ...biomeAddress,
  interactionType: {
    ...activityFields.integer,
    description: "Biome document interaction type as stored (1 observed)."
  },
  path: { ...text3, description: "Path of the document." },
  contentType: {
    ...text3,
    description: "Uniform type identifier of the document, such as com.adobe.pdf."
  },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app the document was used in."
  },
  appUrl: { ...text3, description: "File URL of that app." }
};
var DocumentInteractionsStream = class extends BiomeStream {
  name = "documentInteractions";
  biomeName = "App.DocumentInteraction";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per document an app opened or used on this Mac (Biome App.DocumentInteraction). The file\u2019s bookmark data stays in payload.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  record(payload, address) {
    const file = payload.message(2);
    const app = payload.message(4);
    return {
      ...address,
      interactionType: integer(payload.uint(1)),
      path: file?.string(1),
      contentType: payload.string(3),
      bundleId: app?.string(1),
      appUrl: app?.string(2)
    };
  }
};

// packages/sources/apple/activity/dist/streams/focus-modes-stream.js
var { text: text4, integer: integerField3 } = activityFields;
var properties9 = {
  ...biomeAddress,
  modeId: {
    ...text4,
    description: "Identifier of the configured Focus, a UUID."
  },
  semanticModeId: {
    ...text4,
    description: "What kind of Focus it is, such as com.apple.focus.work or com.apple.sleep.sleep-mode."
  },
  started: {
    ...activityFields.boolean,
    description: "Whether the Focus turned on (true) or off (false)."
  },
  semanticType: {
    ...integerField3,
    description: "Focus kind as stored, such as 2 Do Not Disturb, 3 Sleep, 6 Work, 8 Reading, 1 custom."
  },
  updateReason: {
    ...integerField3,
    description: "Why the Focus changed, as stored."
  },
  updateSource: {
    ...integerField3,
    description: "What changed the Focus, as stored."
  }
};
var FocusModesStream = class extends BiomeStream {
  name = "focusModes";
  biomeName = "UserFocus.ComputedMode";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per Focus turning on or off on this Mac (Biome UserFocus.ComputedMode).",
    properties: properties9,
    required: Object.keys(properties9)
  };
  record(payload, address) {
    return {
      ...address,
      modeId: payload.string(1),
      semanticModeId: payload.string(6),
      started: flag(payload.uint(2)),
      semanticType: integer(payload.uint(4)),
      updateReason: integer(payload.uint(3)),
      updateSource: integer(payload.uint(5))
    };
  }
};

// packages/sources/apple/activity/dist/streams/focus-suggestions-stream.js
var { text: text5, nullableText: nullableText6, integer: integerField4 } = activityFields;
var properties10 = {
  ...biomeAddress,
  suggestionId: {
    ...text5,
    description: "Identifier of one suggestion; the records that start and end it share it."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When the suggestion started or ended."
  },
  started: {
    ...activityFields.boolean,
    description: "Whether the suggestion started (true) or ended (false)."
  },
  modeId: {
    ...nullableText6,
    description: "The Focus suggested, a UUID; recorded on starts only, NULL on ends."
  },
  modeName: {
    ...nullableText6,
    description: "Name of the Focus suggested, such as Work; recorded on starts only."
  },
  modeType: { ...integerField4, description: "Focus mode type as stored." },
  origin: {
    ...integerField4,
    description: "What prompted the suggestion, as stored."
  },
  automationEnabled: {
    ...activityFields.boolean,
    description: "Whether the Focus turns on automatically."
  },
  uiLocation: {
    ...integerField4,
    description: "Where the suggestion was shown, as stored."
  },
  confidence: {
    ...activityFields.number,
    description: "Confidence of the suggestion, 0 to 1."
  },
  shouldSuggestTriggers: {
    ...activityFields.boolean,
    description: "Whether the system suggested triggers for the Focus."
  },
  triggers: {
    ...nullableText6,
    description: "The triggers behind the suggestion, decoded from their keyed archive to JSON; NULL when none."
  }
};
var FocusSuggestionsStream = class extends BiomeStream {
  name = "focusSuggestions";
  biomeName = "UserFocus.InferredMode";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per start or end of a Focus the system inferred and suggested on this Mac (Biome UserFocus.InferredMode).",
    properties: properties10,
    required: Object.keys(properties10)
  };
  record(payload, address) {
    return {
      ...address,
      suggestionId: payload.string(7),
      occurredAt: appleTime(payload.double(1)),
      started: flag(payload.uint(6)),
      modeId: nonEmpty(payload.string(2)),
      modeName: nonEmpty(payload.string(14)),
      modeType: integer(payload.uint(12)),
      origin: integer(payload.uint(3)),
      automationEnabled: flag(payload.uint(5)),
      uiLocation: integer(payload.uint(9)),
      confidence: payload.double(10),
      shouldSuggestTriggers: flag(payload.uint(13)),
      triggers: archiveJSON(payload.bytes(11))
    };
  }
};

// packages/sources/apple/activity/dist/streams/knowledge-intents-stream.js
var { text: text6, nullableText: nullableText7, integer: integerField5 } = activityFields;
var properties11 = {
  ...knowledgeEvent,
  category: {
    ...nullableText7,
    description: "What the interaction was about, such as Messages, Calls or Media; NULL when knowledgeC recorded none."
  },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app that donated the interaction."
  },
  deviceId: {
    ...nullableText7,
    description: "knowledgeC identifier of the device the event came from."
  },
  itemId: {
    ...nullableText7,
    description: "Identifier the app gave the interaction."
  },
  groupId: {
    ...nullableText7,
    description: "Group the interaction belongs to, such as a conversation; NULL when the app gave none."
  },
  intentClass: {
    ...text6,
    description: "SiriKit intent class, such as INSendMessageIntent."
  },
  intentVerb: {
    ...nullableText7,
    description: "SiriKit intent verb, such as SendMessage."
  },
  intentType: { ...integerField5, description: "Intent type as stored." },
  handlingStatus: {
    ...integerField5,
    description: "INIntentHandlingStatus as stored."
  },
  direction: {
    ...integerField5,
    description: "INInteractionDirection as stored: 0 unspecified, 1 outgoing, 2 incoming."
  },
  donatedBySiri: {
    ...activityFields.boolean,
    description: "Whether Siri donated the interaction rather than the app."
  },
  interactionId: {
    ...text6,
    description: "Identifier of the INInteraction."
  },
  derivedIntentId: {
    ...nullableText7,
    description: "Identifier the system derived for the intent."
  },
  relatedContactIds: {
    ...nullableText7,
    description: "Contacts the interaction involved, as knowledgeC stores them; NULL when none."
  },
  interaction: {
    ...nullableText7,
    description: "The donated INInteraction, decoded from its keyed archive to JSON: its intent, response, date interval and participants."
  }
};
var KnowledgeIntentsStream = class extends KnowledgeStream {
  name = "knowledgeIntents";
  streamName = "/app/intents";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per app interaction in knowledgeC (/app/intents), such as a message or call in a messaging app. On a Mac these arrive from the user\u2019s iPhone through knowledge sync.",
    properties: properties11,
    required: Object.keys(properties11)
  };
  columns = `o.ZVALUESTRING, s.ZBUNDLEID, s.ZDEVICEID, s.ZITEMID, s.ZGROUPID,
    m.Z_DKINTENTMETADATAKEY__INTENTCLASS, m.Z_DKINTENTMETADATAKEY__INTENTVERB,
    m.Z_DKINTENTMETADATAKEY__INTENTTYPE, m.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS,
    m.Z_DKINTENTMETADATAKEY__DIRECTION, m.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI,
    m.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER, m.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER,
    m.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS, m.Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION`;
  record(row) {
    return {
      id: row.ZUUID,
      startedAt: appleTime(row.ZSTARTDATE),
      endedAt: appleTime(row.ZENDDATE),
      createdAt: appleTime(row.ZCREATIONDATE),
      utcOffsetSeconds: row.ZSECONDSFROMGMT,
      category: nonEmpty(row.ZVALUESTRING),
      bundleId: row.ZBUNDLEID,
      deviceId: nonEmpty(row.ZDEVICEID),
      itemId: nonEmpty(row.ZITEMID),
      groupId: nonEmpty(row.ZGROUPID),
      intentClass: row.Z_DKINTENTMETADATAKEY__INTENTCLASS,
      intentVerb: nonEmpty(row.Z_DKINTENTMETADATAKEY__INTENTVERB),
      intentType: integer(row.Z_DKINTENTMETADATAKEY__INTENTTYPE),
      handlingStatus: integer(row.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS),
      direction: integer(row.Z_DKINTENTMETADATAKEY__DIRECTION),
      donatedBySiri: flag(row.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI),
      interactionId: row.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER,
      derivedIntentId: nonEmpty(row.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER),
      relatedContactIds: nonEmpty(row.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS),
      interaction: archiveJSON(row.Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION)
    };
  }
};

// packages/sources/apple/activity/dist/streams/media-usage-stream.js
var properties12 = {
  ...biomeAddress,
  usageId: {
    ...activityFields.text,
    description: "Identifier of one playback; the records that start and stop it share it."
  },
  started: {
    ...activityFields.boolean,
    description: "Whether media started (true) or stopped (false)."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When media started or stopped, as the event states it."
  },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app playing media."
  },
  usageTrusted: {
    ...activityFields.boolean,
    description: "Whether Screen Time counts this usage as trusted."
  }
};
var MediaUsageStream = class extends BiomeStream {
  name = "mediaUsage";
  biomeName = "App.MediaUsage";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per start or stop of media an app played on this Mac, as Screen Time counts it (Biome App.MediaUsage).",
    properties: properties12,
    required: Object.keys(properties12)
  };
  record(payload, address) {
    return {
      ...address,
      usageId: payload.string(8),
      started: flag(payload.uint(1)),
      occurredAt: unixTime(payload.double(6)),
      bundleId: payload.string(2),
      usageTrusted: flag(payload.uint(5))
    };
  }
};

// packages/sources/apple/activity/dist/streams/notification-deliveries-stream.js
var properties13 = {
  ...biomeAddress,
  requestId: {
    ...activityFields.text,
    description: "Identifier the app gave the notification request."
  },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app that posted it."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When it was delivered; it can precede recordedAt by hours."
  }
};
var NotificationDeliveriesStream = class extends BiomeStream {
  name = "notificationDeliveries";
  biomeName = "Notification.Delivery";
  retentionDays = 3;
  jsonSchema = {
    type: "object",
    description: "One source record per notification delivered on this Mac (Biome Notification.Delivery). macOS keeps these for three days.",
    properties: properties13,
    required: Object.keys(properties13)
  };
  record(payload, address) {
    return {
      ...address,
      requestId: payload.string(1),
      bundleId: payload.string(2),
      occurredAt: unixTime(payload.double(3))
    };
  }
};

// packages/sources/apple/activity/dist/streams/notification-usage-stream.js
var properties14 = {
  ...biomeAddress,
  notificationId: {
    ...activityFields.text,
    description: "Identifier of the notification, a UUID."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When it happened, as the event states it."
  },
  usageType: {
    ...activityFields.integer,
    description: "What happened to the notification, as stored (1, receipt, observed)."
  },
  bundleId: {
    ...activityFields.text,
    description: "Bundle identifier of the app that posted it, or a system section name."
  }
};
var NotificationUsageStream = class extends BiomeStream {
  name = "notificationUsage";
  biomeName = "Notification.Usage";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per notification event on this Mac (Biome Notification.Usage): which app notified, and when. Biome keeps no title or body here.",
    properties: properties14,
    required: Object.keys(properties14)
  };
  record(payload, address) {
    return {
      ...address,
      notificationId: payload.string(5),
      occurredAt: appleTime(payload.double(2)),
      usageType: integer(payload.uint(3)),
      bundleId: payload.string(4)
    };
  }
};

// packages/sources/apple/activity/dist/streams/now-playing-stream.js
var { nullableText: nullableText8, nullableInteger: nullableInteger3 } = activityFields;
var unknownDuration = 4294967295;
var properties15 = {
  ...biomeAddress,
  occurredAt: {
    ...activityFields.timestamp,
    description: "When playback changed, as the event states it."
  },
  playbackState: {
    ...activityFields.integer,
    description: "MediaRemote playback state as stored: 1 playing, 2 paused, 3 stopped (0 also observed)."
  },
  title: { ...nullableText8, description: "Title of what was playing." },
  artist: { ...nullableText8, description: "Artist of what was playing." },
  album: { ...nullableText8, description: "Album of what was playing." },
  durationSeconds: {
    ...nullableInteger3,
    description: "Length of what was playing; NULL when unknown."
  },
  mediaType: {
    ...nullableText8,
    description: "MediaRemote media type, such as kMRMediaRemoteNowPlayingInfoTypeVideo; NULL when not given."
  },
  airPlayVideo: {
    ...activityFields.boolean,
    description: "Whether the video played over AirPlay."
  },
  bundleId: {
    ...activityFields.nullableText,
    description: "Bundle identifier of the app playing; NULL when Biome recorded none."
  },
  outputDeviceIds: {
    type: "array",
    items: { type: "string" },
    description: "Identifiers of the audio routes playback went to, as recorded on an iPhone; empty when none were recorded."
  }
};
var NowPlayingStream = class extends BiomeStream {
  name = "nowPlaying";
  biomeName = "Media.NowPlaying";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per Now Playing change on this Mac and the devices it syncs with (Biome Media.NowPlaying): what played, in which app, and whether it played, paused or stopped.",
    properties: properties15,
    required: Object.keys(properties15)
  };
  record(payload, address) {
    const duration = integer(payload.uint(6));
    return {
      ...address,
      occurredAt: appleTime(payload.double(2)),
      playbackState: integer(payload.uint(3)),
      title: nonEmpty(payload.string(8)),
      artist: nonEmpty(payload.string(5)),
      album: nonEmpty(payload.string(4)),
      durationSeconds: duration === unknownDuration ? null : duration,
      mediaType: nonEmpty(payload.string(10)),
      airPlayVideo: flag(payload.uint(13)),
      bundleId: nonEmpty(payload.string(15)),
      outputDeviceIds: payload.messages(14).flatMap((device) => nonEmpty(device.string(3)) ?? [])
    };
  }
};

// packages/sources/apple/activity/dist/streams/safari-navigations-stream.js
var { text: text7 } = activityFields;
var properties16 = {
  ...biomeAddress,
  host: { ...text7, description: "Host of the page navigated to." },
  url: { ...text7, description: "URL of the page navigated to." },
  countryCode: {
    ...text7,
    description: "Two-letter country code Biome stores with the navigation."
  },
  periodEndsAt: {
    ...activityFields.timestamp,
    description: "The navigation time rounded up to the next half hour, as stored; recordedAt is the exact time."
  }
};
var SafariNavigationsStream = class extends BiomeStream {
  name = "safariNavigations";
  biomeName = "Safari.Navigations";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per page navigation Safari reports to Biome on this Mac (Biome Safari.Navigations). Clearing Safari history deletes these records. Its other fields are unnamed and stay in payload.",
    properties: properties16,
    required: Object.keys(properties16)
  };
  record(payload, address) {
    return {
      ...address,
      host: payload.string(1),
      url: payload.string(8),
      countryCode: payload.string(5),
      periodEndsAt: unixTime(payload.double(2))
    };
  }
};

// packages/sources/apple/activity/dist/streams/screen-time-app-usage-stream.js
var properties17 = {
  ...biomeAddress,
  started: {
    ...activityFields.boolean,
    description: "Whether app usage started (true) or ended (false)."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When usage started or ended, as the event states it."
  },
  bundleId: activityFields.bundleId,
  usageTrusted: {
    ...activityFields.boolean,
    description: "Whether Screen Time counts this usage as trusted."
  }
};
var ScreenTimeAppUsageStream = class extends BiomeStream {
  name = "screenTimeAppUsage";
  biomeName = "ScreenTime.AppUsage";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per start or end of app usage that Screen Time counts (Biome ScreenTime.AppUsage) on this Mac. It follows appFocus without system interface such as the Dock or the login window.",
    properties: properties17,
    required: Object.keys(properties17)
  };
  record(payload, address) {
    return {
      ...address,
      started: flag(payload.uint(1)),
      occurredAt: unixTime(payload.double(2)),
      bundleId: payload.string(3),
      usageTrusted: flag(payload.uint(5))
    };
  }
};

// packages/sources/apple/activity/dist/streams/screenshots-stream.js
var { integer: integerField6 } = activityFields;
var properties18 = {
  ...biomeAddress,
  path: {
    ...activityFields.nullableText,
    description: "Where the screenshot was saved; NULL when it went somewhere other than a file."
  },
  screenshotSource: {
    ...integerField6,
    description: "How the screenshot was taken, as stored."
  },
  screenshotLocation: {
    ...integerField6,
    description: "Where it was sent, as stored."
  },
  screenshotStyle: {
    ...integerField6,
    description: "Screenshot style as stored."
  }
};
var ScreenshotsStream = class extends BiomeStream {
  name = "screenshots";
  biomeName = "Screenshots.Screenshot";
  retentionDays = 1;
  jsonSchema = {
    type: "object",
    description: "One source record per screenshot taken on this Mac (Biome Screenshots.Screenshot). macOS keeps these for one day.",
    properties: properties18,
    required: Object.keys(properties18)
  };
  record(payload, address) {
    const screenshot = payload.message(1);
    return {
      ...address,
      path: screenshot?.message(4)?.string(1) ?? null,
      screenshotSource: integer(screenshot?.uint(1)),
      screenshotLocation: integer(screenshot?.uint(2)),
      screenshotStyle: integer(screenshot?.uint(6))
    };
  }
};

// packages/sources/apple/activity/dist/streams/web-usage-stream.js
var { text: text8 } = activityFields;
var properties19 = {
  ...biomeAddress,
  usageId: {
    ...text8,
    description: "Identifier of one visit; the records that start and end it share it."
  },
  occurredAt: {
    ...activityFields.timestamp,
    description: "When the usage state changed, as the event states it."
  },
  usageState: {
    ...activityFields.integer,
    description: "Biome web usage state as stored (1, 2 and 3 observed; a visit starts and ends with different states)."
  },
  url: { ...text8, description: "The page URL." },
  domain: { ...text8, description: "The web domain Screen Time counts." },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the browser."
  },
  usageTrusted: {
    ...activityFields.boolean,
    description: "Whether Screen Time counts this usage as trusted."
  },
  safariProfileId: {
    ...activityFields.nullableText,
    description: "The Safari profile the page was open in; NULL when none."
  }
};
var WebUsageStream = class extends BiomeStream {
  name = "webUsage";
  biomeName = "App.WebUsage";
  retentionDays = 28;
  jsonSchema = {
    type: "object",
    description: "One source record per change of a web page\u2019s usage that Screen Time counts on this Mac (Biome App.WebUsage). Clearing browsing history deletes these records.",
    properties: properties19,
    required: Object.keys(properties19)
  };
  record(payload, address) {
    return {
      ...address,
      usageId: payload.string(1),
      occurredAt: appleTime(payload.double(2)),
      usageState: integer(payload.uint(3)),
      url: payload.string(4),
      domain: payload.string(5),
      bundleId: payload.string(6),
      usageTrusted: flag(payload.uint(8)),
      safariProfileId: nonEmpty(payload.string(9))
    };
  }
};

// packages/sources/apple/activity/dist/apple-activity-source.js
var readers = {
  appFocus: new AppFocusStream(),
  screenTimeAppUsage: new ScreenTimeAppUsageStream(),
  appMenuItems: new AppMenuItemsStream(),
  appIntents: new AppIntentsStream(),
  webUsage: new WebUsageStream(),
  safariNavigations: new SafariNavigationsStream(),
  documentInteractions: new DocumentInteractionsStream(),
  mediaUsage: new MediaUsageStream(),
  nowPlaying: new NowPlayingStream(),
  focusModes: new FocusModesStream(),
  focusSuggestions: new FocusSuggestionsStream(),
  notificationUsage: new NotificationUsageStream(),
  notificationDeliveries: new NotificationDeliveriesStream(),
  bluetoothConnections: new BluetoothConnectionsStream(),
  screenshots: new ScreenshotsStream(),
  knowledgeIntents: new KnowledgeIntentsStream(),
  displayBacklight: new DisplayBacklightStream(),
  discoverabilitySignals: new DiscoverabilitySignalsStream(),
  devices: new DevicesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var readerOf = (stream) => {
  const reader = readersByName.get(stream.name);
  if (reader === void 0)
    throw new Error(`Apple Activity has no stream ${stream.name}`);
  return reader;
};
var AppleActivitySource = class extends Source {
  identity;
  catalog = catalog;
  appFocus = readers.appFocus.describe();
  screenTimeAppUsage = readers.screenTimeAppUsage.describe();
  appMenuItems = readers.appMenuItems.describe();
  appIntents = readers.appIntents.describe();
  webUsage = readers.webUsage.describe();
  safariNavigations = readers.safariNavigations.describe();
  documentInteractions = readers.documentInteractions.describe();
  mediaUsage = readers.mediaUsage.describe();
  nowPlaying = readers.nowPlaying.describe();
  focusModes = readers.focusModes.describe();
  focusSuggestions = readers.focusSuggestions.describe();
  notificationUsage = readers.notificationUsage.describe();
  notificationDeliveries = readers.notificationDeliveries.describe();
  bluetoothConnections = readers.bluetoothConnections.describe();
  screenshots = readers.screenshots.describe();
  knowledgeIntents = readers.knowledgeIntents.describe();
  displayBacklight = readers.displayBacklight.describe();
  discoverabilitySignals = readers.discoverabilitySignals.describe();
  devices = readers.devices.describe();
  location;
  // How often a watch checks the stores. App focus records arrive with every
  // switch between apps, so a minute gathers them into one pass.
  pollIntervalMs;
  constructor({ biome = defaultActivityLocation.biome, knowledge = defaultActivityLocation.knowledge, pollIntervalMs = 6e4 } = {}) {
    super();
    this.location = Object.freeze({ biome, knowledge });
    this.pollIntervalMs = pollIntervalMs;
    this.identity = `apple-activity:${biome}:${knowledge}`;
    Object.freeze(this);
  }
  open(streams) {
    return ActivityScan.open(this.location, new Set(streams.map((stream) => readerOf(stream).store)));
  }
  coverage(stream) {
    const { retentionDays } = readerOf(stream);
    return {
      description: retentionDays === null ? "Every device Biome lists now." : `Every record macOS still keeps of this stream, up to ${retentionDays} days back, from this Mac and the devices it syncs with. Rows of records macOS has since dropped stay loaded; a deletion within that age deletes the row.`,
      selection: { retentionDays }
    };
  }
  // Biome writes into preallocated segment files in place, so neither their
  // size, their modification time nor FSEvents report a new record; each
  // segment's trailer does. Databases report commits through data_version.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const versions = __using(_stack, new DisposableStack());
      const version = (path) => {
        const database = versions.use(new ActivityDatabaseVersion(path));
        return async () => String(database.current);
      };
      const probes = /* @__PURE__ */ new Map();
      const databases = /* @__PURE__ */ new Map();
      for (const stream of streams) {
        const reader = readerOf(stream);
        if (reader instanceof BiomeStream) {
          const root = biomeStreams(this.location);
          probes.set(stream, async () => (await Promise.all((await segments(root, reader.biomeName)).map(async (segment) => `${segment.origin}/${segment.name}=${await segmentFingerprint(segment)}`))).join("|"));
          continue;
        }
        if (!databases.has(reader.store))
          databases.set(reader.store, version(reader.store === "knowledge" ? this.location.knowledge : biomeDevices(this.location)));
        const probe = databases.get(reader.store);
        if (probe !== void 0)
          probes.set(stream, probe);
      }
      const seen = /* @__PURE__ */ new Map();
      for (const [stream, probe] of probes)
        seen.set(stream, await probe());
      yield streams;
      try {
        for await (const _2 of setInterval(this.pollIntervalMs, void 0, {
          signal
        })) {
          const changed = [];
          for (const [stream, probe] of probes) {
            const current = await probe();
            if (current === seen.get(stream))
              continue;
            seen.set(stream, current);
            changed.push(stream);
          }
          if (changed.length > 0)
            yield changed;
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
  extract(configuration, state, _partition, scan) {
    return readerOf(configuration.stream).messages(configuration, state, scan);
  }
};

// packages/connectors/apple/activity/dist/activity-connector.js
var ActivityConnector = class extends AppleConnector {
  datedBy = null;
  fullDiskAccess = true;
  // macOS keeps a few weeks of activity; everything it keeps is imported.
  choices = [];
  // A small Biome stream: reading it lists the protected Biome folder.
  probe = "appMenuItems";
  unscoped = [];
  storeCopies = [];
  access() {
    return "No app needs to be open: macOS records this activity on its own.";
  }
  source() {
    return new AppleActivitySource();
  }
};
export {
  ActivityConnector as default
};
