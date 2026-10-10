import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  ProtobufMessage
} from "../../chunks/chunk-QMS7KGTZ.mjs";
import {
  decodeArchive,
  plistJSON
} from "../../chunks/chunk-QPPOHR2G.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-DV4S52G7.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-QNQLFEII.mjs";
import "../../chunks/chunk-YZBCNEVG.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffGroupedSnapshot,
  diffSnapshot,
  expiredAfter,
  validateRecords
} from "../../chunks/chunk-2UKXR4JG.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/activity/dist/apple-activity-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/biome/dist/biome-store.js
import { readdir as readdir2 } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// packages/sdks/apple/biome/dist/biome-segment.js
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// packages/codecs/segb/dist/segb.js
import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
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
    const file = __using(_stack, await open(path), true);
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

// packages/sdks/apple/biome/dist/errors.js
var BiomeUnavailableError = class extends Error {
  name = "BiomeUnavailableError";
  constructor(path, cause) {
    super(`Biome's store at ${path} cannot be read. Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`, { cause });
  }
};
var BiomeSchemaError = class extends Error {
  name = "BiomeSchemaError";
  constructor(path, missing) {
    super(`Biome's device list at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/biome/dist/biome-segment.js
var decodingVersion = 1;
var BiomeSegment = class {
  origin;
  name;
  #path;
  #stream;
  constructor(stream, origin, name, path) {
    this.#stream = stream;
    this.origin = origin;
    this.name = name;
    this.#path = path;
  }
  // Changes whenever Biome appends or deletes a record. Biome writes into a
  // preallocated file in place, so neither its size nor its modification time
  // does.
  async fingerprint() {
    return `${decodingVersion}:${await segbFingerprint(this.#path)}`;
  }
  // The intact records, in slot order. Biome zero-fills a deleted record in
  // place and leaves some written slots zeroed; neither is a record.
  async records() {
    const records = [];
    for (const { slot, writtenAt, payload } of await readSegb(this.#path)) {
      if (payload === null)
        continue;
      records.push({
        slot,
        writtenAt,
        payload,
        event: this.#stream.decode(new ProtobufMessage(payload))
      });
    }
    return records;
  }
};
async function segments(streams, stream) {
  const files = async (origin, directory) => (await entries(directory)).filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => new BiomeSegment(stream, origin, entry.name, join(directory, entry.name)));
  const folder = join(streams, stream.name);
  const devices = (await entries(join(folder, "remote"))).filter((entry) => entry.isDirectory());
  return [
    ...await files("local", join(folder, "local")),
    ...(await Promise.all(devices.map((device) => files(device.name, join(folder, "remote", device.name))))).flat()
  ];
}
async function entries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return [];
    throw new BiomeUnavailableError(directory, cause);
  }
}

// packages/sdks/apple/biome/dist/biome-sync.js
var columns = {
  DevicePeer: [
    "device_identifier",
    "me",
    "name",
    "model",
    "platform",
    "last_sync_date"
  ]
};
var text = (value) => typeof value === "string" && value !== "" ? value : void 0;
var BiomeSync = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, BiomeUnavailableError);
    this.#database.requireColumns(columns, BiomeSchemaError);
  }
  devices() {
    return this.#database.all("SELECT device_identifier, me, name, CAST(model AS TEXT) AS model, platform, last_sync_date FROM DevicePeer ORDER BY device_identifier").map((row) => ({
      id: typeof row.device_identifier === "string" ? row.device_identifier : void 0,
      thisMac: row.me === 1,
      name: text(row.name),
      model: text(row.model),
      platform: typeof row.platform === "number" && Number.isSafeInteger(row.platform) ? row.platform : void 0,
      lastSyncedAt: typeof row.last_sync_date === "number" && Number.isFinite(row.last_sync_date) ? new Date(Math.round(row.last_sync_date * 1e3)) : void 0
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};

// packages/sdks/apple/biome/dist/biome-store.js
var biomeDirectory = join2(homedir(), "Library/Biome");
var BiomeStreams = class {
  #path;
  constructor(path) {
    this.#path = path;
  }
  segments(stream) {
    return segments(this.#path, stream);
  }
};
var BiomeStore = class {
  #streams;
  #sync;
  constructor(root) {
    this.#streams = join2(root, "streams/restricted");
    this.#sync = join2(root, "sync/sync.db");
  }
  async streams() {
    try {
      await readdir2(this.#streams);
    } catch (cause) {
      throw new BiomeUnavailableError(this.#streams, cause);
    }
    return new BiomeStreams(this.#streams);
  }
  // The device list in one snapshot. Hold it only while reading: an open read
  // stops Biome checkpointing the database's WAL.
  sync() {
    return new BiomeSync(this.#sync);
  }
  // What changes when a stream does: its segment listing and each segment's
  // fingerprint. FSEvents reports nothing, since Biome writes in place.
  async version(stream) {
    const found = await segments(this.#streams, stream);
    return (await Promise.all(found.map(async (segment) => `${segment.origin}/${segment.name}=${await segment.fingerprint()}`))).join("|");
  }
  // Biome commits the device list through a WAL it keeps open.
  syncVersion() {
    return new AppDatabaseVersion(this.#sync, BiomeUnavailableError);
  }
};

// packages/sdks/apple/biome/dist/biome-stream.js
var BiomeStream = class {
};

// packages/sdks/apple/biome/dist/streams/app-document-interaction.js
var AppDocumentInteraction = class extends BiomeStream {
  name = "App.DocumentInteraction";
  maximumAgeDays = 28;
  decode(message) {
    const file = message.message(2);
    const app = message.message(4);
    return {
      interactionType: message.uint(1),
      path: file?.string(1),
      contentType: message.string(3),
      bundleId: app?.string(1),
      appUrl: app?.string(2)
    };
  }
};

// packages/sdks/apple/biome/dist/biome-values.js
var appleEpochSeconds = 978307200;
var instant = (seconds) => new Date(Math.round(seconds * 1e3));
var finite = (value) => value !== void 0 && Number.isFinite(value);
var appleDate = (seconds) => finite(seconds) ? instant(seconds + appleEpochSeconds) : void 0;
var unixDate = (seconds) => finite(seconds) ? instant(seconds) : void 0;
var optionalText = (value) => value === "" ? void 0 : value;
var flag = (value) => value === void 0 ? void 0 : value !== 0;
var archive = (bytes) => bytes !== void 0 && bytes.length > 0 ? decodeArchive(bytes) : void 0;

// packages/sdks/apple/biome/dist/streams/app-in-focus.js
var AppInFocus = class extends BiomeStream {
  name = "App.InFocus";
  maximumAgeDays = 28;
  decode(message) {
    return {
      started: flag(message.uint(3)),
      occurredAt: appleDate(message.double(4)),
      bundleId: message.string(6),
      launchReason: optionalText(message.string(1)),
      eventType: message.uint(2),
      shortVersion: optionalText(message.string(9)),
      bundleVersion: optionalText(message.string(10)),
      platform: message.uint(11),
      nativeArchitecture: flag(message.uint(12)),
      displayType: message.uint(13)
    };
  }
};

// packages/sdks/apple/biome/dist/streams/app-intent.js
var AppIntent = class extends BiomeStream {
  name = "App.Intent";
  maximumAgeDays = 28;
  decode(message) {
    return {
      occurredAt: appleDate(message.double(1)),
      bundleId: message.string(2),
      sourceId: message.string(3),
      intentClass: message.string(4),
      intentVerb: message.string(5),
      intentType: message.uint(6),
      handlingStatus: message.uint(7),
      direction: message.uint(11),
      donatedBySiri: flag(message.uint(10)),
      itemId: message.string(9),
      groupId: optionalText(message.string(12)),
      interaction: archive(message.bytes(8))
    };
  }
};

// packages/sdks/apple/biome/dist/streams/app-media-usage.js
var AppMediaUsage = class extends BiomeStream {
  name = "App.MediaUsage";
  maximumAgeDays = 28;
  decode(message) {
    return {
      usageId: message.string(8),
      started: flag(message.uint(1)),
      occurredAt: unixDate(message.double(6)),
      bundleId: message.string(2),
      usageTrusted: flag(message.uint(5))
    };
  }
};

// packages/sdks/apple/biome/dist/streams/app-menu-item.js
var AppMenuItem = class extends BiomeStream {
  name = "App.MenuItem";
  maximumAgeDays = 28;
  decode(message) {
    return { bundleId: message.string(1) };
  }
};

// packages/sdks/apple/biome/dist/streams/app-web-usage.js
var AppWebUsage = class extends BiomeStream {
  name = "App.WebUsage";
  maximumAgeDays = 28;
  decode(message) {
    return {
      usageId: message.string(1),
      occurredAt: appleDate(message.double(2)),
      usageState: message.uint(3),
      url: message.string(4),
      domain: message.string(5),
      bundleId: message.string(6),
      usageTrusted: flag(message.uint(8)),
      safariProfileId: optionalText(message.string(9))
    };
  }
};

// packages/sdks/apple/biome/dist/streams/device-wireless-bluetooth.js
var DeviceWirelessBluetooth = class extends BiomeStream {
  name = "Device.Wireless.Bluetooth";
  maximumAgeDays = 28;
  decode(message) {
    return {
      address: message.string(1),
      deviceName: optionalText(message.string(2)),
      connected: flag(message.uint(4)),
      vendorId: message.uint(11),
      productId: message.uint(3),
      deviceType: message.uint(5),
      appleAudioDevice: flag(message.uint(9)),
      userWearing: flag(message.uint(10)),
      batteryCase: message.uint(6),
      batteryLeft: message.uint(8),
      batteryRight: message.uint(7)
    };
  }
};

// packages/sdks/apple/biome/dist/streams/media-now-playing.js
var unknownDuration = 4294967295;
var MediaNowPlaying = class extends BiomeStream {
  name = "Media.NowPlaying";
  maximumAgeDays = 28;
  decode(message) {
    const duration = message.uint(6);
    return {
      occurredAt: appleDate(message.double(2)),
      playbackState: message.uint(3),
      title: optionalText(message.string(8)),
      artist: optionalText(message.string(5)),
      album: optionalText(message.string(4)),
      durationSeconds: duration === unknownDuration ? void 0 : duration,
      mediaType: optionalText(message.string(10)),
      airPlayVideo: flag(message.uint(13)),
      bundleId: optionalText(message.string(15)),
      outputDeviceIds: message.messages(14).flatMap((device) => optionalText(device.string(3)) ?? [])
    };
  }
};

// packages/sdks/apple/biome/dist/streams/notification-delivery.js
var NotificationDelivery = class extends BiomeStream {
  name = "Notification.Delivery";
  maximumAgeDays = 3;
  decode(message) {
    return {
      requestId: message.string(1),
      bundleId: message.string(2),
      occurredAt: unixDate(message.double(3))
    };
  }
};

// packages/sdks/apple/biome/dist/streams/notification-usage.js
var NotificationUsage = class extends BiomeStream {
  name = "Notification.Usage";
  maximumAgeDays = 28;
  decode(message) {
    return {
      notificationId: message.string(5),
      occurredAt: appleDate(message.double(2)),
      usageType: message.uint(3),
      bundleId: message.string(4)
    };
  }
};

// packages/sdks/apple/biome/dist/streams/safari-navigations.js
var SafariNavigations = class extends BiomeStream {
  name = "Safari.Navigations";
  maximumAgeDays = 28;
  decode(message) {
    return {
      host: message.string(1),
      url: message.string(8),
      countryCode: message.string(5),
      periodEndsAt: unixDate(message.double(2))
    };
  }
};

// packages/sdks/apple/biome/dist/streams/screen-time-app-usage.js
var ScreenTimeAppUsage = class extends BiomeStream {
  name = "ScreenTime.AppUsage";
  maximumAgeDays = 28;
  decode(message) {
    return {
      started: flag(message.uint(1)),
      occurredAt: unixDate(message.double(2)),
      bundleId: message.string(3),
      usageTrusted: flag(message.uint(5))
    };
  }
};

// packages/sdks/apple/biome/dist/streams/screenshots-screenshot.js
var ScreenshotsScreenshot = class extends BiomeStream {
  name = "Screenshots.Screenshot";
  maximumAgeDays = 1;
  decode(message) {
    const screenshot = message.message(1);
    return {
      path: screenshot?.message(4)?.string(1),
      screenshotSource: screenshot?.uint(1),
      screenshotLocation: screenshot?.uint(2),
      screenshotStyle: screenshot?.uint(6)
    };
  }
};

// packages/sdks/apple/biome/dist/streams/user-focus-computed-mode.js
var UserFocusComputedMode = class extends BiomeStream {
  name = "UserFocus.ComputedMode";
  maximumAgeDays = 28;
  decode(message) {
    return {
      modeId: message.string(1),
      semanticModeId: message.string(6),
      started: flag(message.uint(2)),
      semanticType: message.uint(4),
      updateReason: message.uint(3),
      updateSource: message.uint(5)
    };
  }
};

// packages/sdks/apple/biome/dist/streams/user-focus-inferred-mode.js
var UserFocusInferredMode = class extends BiomeStream {
  name = "UserFocus.InferredMode";
  maximumAgeDays = 28;
  decode(message) {
    return {
      suggestionId: message.string(7),
      occurredAt: appleDate(message.double(1)),
      started: flag(message.uint(6)),
      modeId: optionalText(message.string(2)),
      modeName: optionalText(message.string(14)),
      modeType: message.uint(12),
      origin: message.uint(3),
      automationEnabled: flag(message.uint(5)),
      uiLocation: message.uint(9),
      confidence: message.double(10),
      shouldSuggestTriggers: flag(message.uint(13)),
      triggers: archive(message.bytes(11))
    };
  }
};

// packages/sdks/apple/knowledge/dist/errors.js
var KnowledgeUnavailableError = class extends Error {
  name = "KnowledgeUnavailableError";
  constructor(path, cause) {
    super(`knowledgeC at ${path} cannot be read. Allow the process that reads it Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it.`, { cause });
  }
};
var KnowledgeSchemaError = class extends Error {
  name = "KnowledgeSchemaError";
  constructor(path, missing) {
    super(`knowledgeC at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/knowledge/dist/knowledge-store.js
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// packages/sdks/apple/knowledge/dist/knowledge-values.js
var appleEpochSeconds2 = 978307200;
var text2 = (value) => typeof value === "string" ? value : void 0;
var optionalText2 = (value) => typeof value === "string" && value !== "" ? value : void 0;
var integer = (value) => typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
var flag2 = (value) => typeof value === "number" ? value !== 0 : void 0;
var appleDate2 = (value) => typeof value === "number" && Number.isFinite(value) ? new Date(Math.round((value + appleEpochSeconds2) * 1e3)) : void 0;
var archive2 = (value) => value instanceof Uint8Array && value.length > 0 ? decodeArchive(value) : void 0;

// packages/sdks/apple/knowledge/dist/knowledge-store.js
var knowledgeStorePath = join3(homedir2(), "Library/Application Support/Knowledge/knowledgeC.db");
var tables = [
  { name: "ZOBJECT", alias: "o" },
  { name: "ZSTRUCTUREDMETADATA", alias: "m" },
  { name: "ZSOURCE", alias: "s" }
];
var eventColumns = {
  ZOBJECT: [
    "ZUUID",
    "ZSTARTDATE",
    "ZENDDATE",
    "ZCREATIONDATE",
    "ZSECONDSFROMGMT"
  ]
};
var queryColumns = {
  ZOBJECT: ["Z_PK", "ZSTREAMNAME", "ZSTRUCTUREDMETADATA", "ZSOURCE"],
  ZSTRUCTUREDMETADATA: ["Z_PK"],
  ZSOURCE: ["Z_PK"]
};
var columnsOf = (sets, table) => sets.flatMap((set) => set[table] ?? []);
var KnowledgeSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, KnowledgeUnavailableError);
  }
  // A stream's events in the order knowledgeC stored them. Each read checks
  // only the columns it reads, so a layout change fails only the streams it
  // touches.
  events(stream) {
    const missing = this.#database.missingColumns(Object.fromEntries(tables.map(({ name }) => [
      name,
      columnsOf([queryColumns, eventColumns, stream.columns], name)
    ])));
    if (missing.length > 0)
      throw new KnowledgeSchemaError(this.#database.path, missing);
    const selected = tables.flatMap(({ name, alias }) => columnsOf([eventColumns, stream.columns], name).map((column) => `${alias}.${column}`));
    return this.#database.all(`SELECT ${selected.join(", ")}
         FROM ZOBJECT o
         LEFT JOIN ZSTRUCTUREDMETADATA m ON m.Z_PK = o.ZSTRUCTUREDMETADATA
         LEFT JOIN ZSOURCE s ON s.Z_PK = o.ZSOURCE
         WHERE o.ZSTREAMNAME = ? ORDER BY o.Z_PK`, stream.name).map((row) => ({
      id: text2(row.ZUUID),
      startedAt: appleDate2(row.ZSTARTDATE),
      endedAt: appleDate2(row.ZENDDATE),
      createdAt: appleDate2(row.ZCREATIONDATE),
      utcOffsetSeconds: integer(row.ZSECONDSFROMGMT),
      ...stream.decode(row)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
};
var KnowledgeStore = class {
  #path;
  constructor(path) {
    this.#path = path;
  }
  open() {
    return new KnowledgeSnapshot(this.#path);
  }
  // knowledgeC commits through a WAL it keeps open.
  version() {
    return new AppDatabaseVersion(this.#path, KnowledgeUnavailableError);
  }
};

// packages/sdks/apple/knowledge/dist/knowledge-stream.js
var KnowledgeStream = class {
};

// packages/sdks/apple/knowledge/dist/streams/app-intents.js
var AppIntents = class extends KnowledgeStream {
  name = "/app/intents";
  maximumAgeDays = 28;
  columns = {
    ZOBJECT: ["ZVALUESTRING"],
    ZSOURCE: ["ZBUNDLEID", "ZDEVICEID", "ZITEMID", "ZGROUPID"],
    ZSTRUCTUREDMETADATA: [
      "Z_DKINTENTMETADATAKEY__INTENTCLASS",
      "Z_DKINTENTMETADATAKEY__INTENTVERB",
      "Z_DKINTENTMETADATAKEY__INTENTTYPE",
      "Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS",
      "Z_DKINTENTMETADATAKEY__DIRECTION",
      "Z_DKINTENTMETADATAKEY__DONATEDBYSIRI",
      "Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER",
      "Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER",
      "Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS",
      "Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION"
    ]
  };
  decode(row) {
    return {
      category: optionalText2(row.ZVALUESTRING),
      bundleId: text2(row.ZBUNDLEID),
      deviceId: optionalText2(row.ZDEVICEID),
      itemId: optionalText2(row.ZITEMID),
      groupId: optionalText2(row.ZGROUPID),
      intentClass: text2(row.Z_DKINTENTMETADATAKEY__INTENTCLASS),
      intentVerb: optionalText2(row.Z_DKINTENTMETADATAKEY__INTENTVERB),
      intentType: integer(row.Z_DKINTENTMETADATAKEY__INTENTTYPE),
      handlingStatus: integer(row.Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS),
      direction: integer(row.Z_DKINTENTMETADATAKEY__DIRECTION),
      donatedBySiri: flag2(row.Z_DKINTENTMETADATAKEY__DONATEDBYSIRI),
      interactionId: text2(row.Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER),
      derivedIntentId: optionalText2(row.Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER),
      relatedContactIds: optionalText2(row.Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS),
      interaction: archive2(row.Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION)
    };
  }
};

// packages/sdks/apple/knowledge/dist/streams/discoverability-signals.js
var DiscoverabilitySignals = class extends KnowledgeStream {
  name = "/discoverability/signals";
  maximumAgeDays = 730;
  columns = {
    ZOBJECT: ["ZVALUESTRING"],
    ZSOURCE: ["ZBUNDLEID"],
    ZSTRUCTUREDMETADATA: [
      "Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD",
      "Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO"
    ]
  };
  decode(row) {
    return {
      signal: optionalText2(row.ZVALUESTRING),
      bundleId: optionalText2(row.ZBUNDLEID),
      osBuild: optionalText2(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD),
      userInfo: archive2(row.Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO)
    };
  }
};

// packages/sdks/apple/knowledge/dist/streams/display-is-backlit.js
var DisplayIsBacklit = class extends KnowledgeStream {
  name = "/display/isBacklit";
  maximumAgeDays = 28;
  columns = { ZOBJECT: ["ZVALUEINTEGER"] };
  decode(row) {
    return { backlit: flag2(row.ZVALUEINTEGER) };
  }
};

// packages/sources/apple/activity/dist/activity-scan.js
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
      const open2 = async (store, value) => {
        if (!stores.has(store))
          return void 0;
        try {
          return { value: await value() };
        } catch (error) {
          return { error };
        }
      };
      const biome = new BiomeStore(location.biome);
      const opened = {
        biome: await open2("biome", () => biome.streams()),
        knowledge: await open2("knowledge", () => resources.use(new KnowledgeStore(location.knowledge).open())),
        devices: await open2("devices", () => resources.use(biome.sync()))
      };
      return new _ActivityScan(startedAt, resources.move(), opened);
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
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

// packages/sources/apple/activity/dist/activity-values.js
var text3 = { type: "string" };
var nullableText = { type: ["string", "null"] };
var activityFields = {
  text: text3,
  nullableText,
  integer: { type: "integer" },
  nullableInteger: { type: ["integer", "null"] },
  number: { type: "number" },
  boolean: { type: "boolean" },
  nullableBoolean: { type: ["boolean", "null"] },
  timestamp: { ...text3, format: "date-time" },
  nullableTimestamp: { ...nullableText, format: "date-time" },
  bundleId: {
    ...text3,
    minLength: 1,
    description: "Bundle identifier of the app, such as com.apple.Safari."
  }
};
var isoTime = (at) => at?.toISOString() ?? null;
var plistText = (value) => value === void 0 ? null : plistJSON(value);
var dayMs = 864e5;
var marginMs = 36e5;
var retainedSince = (startedAt, retentionDays) => new Date(startedAt.getTime() - retentionDays * dayMs + marginMs).toISOString();

// packages/sources/apple/activity/dist/biome-activity-stream.js
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
var BiomeActivityStream = class {
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
  get retentionDays() {
    return this.biome.maximumAgeDays;
  }
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  // Incremental copies read only the segments whose fingerprint changed, and
  // keep the rows of records macOS expired.
  async *messages(configuration, state, scan) {
    const found = await scan.biome.segments(this.biome);
    if (configuration.syncMode === "full_refresh") {
      for (const segment of found)
        for await (const data of this.#read(segment))
          yield { stream: this.name, data };
      return;
    }
    const groups = await Promise.all(found.map(async (segment) => ({
      key: `${segment.origin}/${segment.name}`,
      fingerprint: `${parserVersion}:${await segment.fingerprint()}`,
      records: () => this.#read(segment)
    })));
    yield* diffGroupedSnapshot(configuration.stream, groups, state, {
      covers: expiredAfter(retainedSince(scan.startedAt, this.retentionDays))
    });
  }
  async *#read(segment) {
    const drafts = (await segment.records()).map((record) => this.record(record.event, {
      origin: segment.origin,
      segment: segment.name,
      slot: record.slot,
      recordedAt: record.writtenAt.toISOString(),
      payload: Buffer.from(record.payload).toString("base64")
    }));
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
var AppFocusStream = class extends BiomeActivityStream {
  name = "appFocus";
  biome = new AppInFocus();
  jsonSchema = {
    type: "object",
    description: "One source record per app focus change (Biome App.InFocus) on this Mac and the devices it syncs with: an app coming into the foreground, or leaving it. A session runs from a start to the next end of the same app and origin.",
    properties,
    required: Object.keys(properties)
  };
  record(event, address) {
    return {
      ...address,
      started: event.started ?? null,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      launchReason: event.launchReason ?? null,
      eventType: event.eventType ?? null,
      shortVersion: event.shortVersion ?? null,
      bundleVersion: event.bundleVersion ?? null,
      platform: event.platform ?? null,
      nativeArchitecture: event.nativeArchitecture ?? null,
      displayType: event.displayType ?? null
    };
  }
};

// packages/sources/apple/activity/dist/streams/app-intents-stream.js
var { text: text4, integer: integerField, nullableText: nullableText3 } = activityFields;
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
  sourceId: { ...text4, description: "Biome intent source as stored." },
  intentClass: {
    ...text4,
    description: "SiriKit intent class, such as INSendMessageIntent."
  },
  intentVerb: {
    ...text4,
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
    ...text4,
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
var AppIntentsStream = class extends BiomeActivityStream {
  name = "appIntents";
  biome = new AppIntent();
  jsonSchema = {
    type: "object",
    description: "One source record per interaction an app donated to the system on this Mac (Biome App.Intent), such as a message sent or received through a messaging app.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  record(event, address) {
    return {
      ...address,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      sourceId: event.sourceId,
      intentClass: event.intentClass,
      intentVerb: event.intentVerb,
      intentType: event.intentType ?? null,
      handlingStatus: event.handlingStatus ?? null,
      direction: event.direction ?? null,
      donatedBySiri: event.donatedBySiri ?? null,
      itemId: event.itemId,
      groupId: event.groupId ?? null,
      interaction: plistText(event.interaction)
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
var AppMenuItemsStream = class extends BiomeActivityStream {
  name = "appMenuItems";
  biome = new AppMenuItem();
  jsonSchema = {
    type: "object",
    description: "One source record per use of an app's menu bar on this Mac (Biome App.MenuItem). Biome records which app, not which item.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  record(event, address) {
    return {
      ...address,
      bundleId: event.bundleId
    };
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
var BluetoothConnectionsStream = class extends BiomeActivityStream {
  name = "bluetoothConnections";
  biome = new DeviceWirelessBluetooth();
  jsonSchema = {
    type: "object",
    description: "One source record per Bluetooth device connecting or disconnecting on this Mac and the devices it syncs with (Biome Device.Wireless.Bluetooth).",
    properties: properties4,
    required: Object.keys(properties4)
  };
  record(event, address) {
    return {
      ...address,
      address: event.address,
      deviceName: event.deviceName ?? null,
      connected: event.connected ?? null,
      vendorId: event.vendorId ?? null,
      productId: event.productId ?? null,
      deviceType: event.deviceType ?? null,
      appleAudioDevice: event.appleAudioDevice ?? null,
      userWearing: event.userWearing ?? null,
      batteryCase: event.batteryCase ?? null,
      batteryLeft: event.batteryLeft ?? null,
      batteryRight: event.batteryRight ?? null
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
    return validateRecords(this, scan.devices.devices().map((device) => this.#record(device)), "Activity");
  }
  #record(device) {
    return {
      deviceId: device.id,
      thisMac: device.thisMac,
      name: device.name ?? null,
      model: device.model ?? null,
      platform: device.platform ?? null,
      lastSyncedAt: isoTime(device.lastSyncedAt)
    };
  }
};

// packages/sources/apple/activity/dist/knowledge-activity-stream.js
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
var knowledgeEventRecord = (event) => ({
  id: event.id,
  startedAt: isoTime(event.startedAt),
  endedAt: isoTime(event.endedAt),
  createdAt: isoTime(event.createdAt),
  utcOffsetSeconds: event.utcOffsetSeconds
});
var KnowledgeActivityStream = class {
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
  get retentionDays() {
    return this.knowledge.maximumAgeDays;
  }
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  async *messages(configuration, state, scan) {
    const records = this.#read(scan);
    if (configuration.syncMode === "full_refresh")
      yield* records.map((data) => ({ stream: this.name, data }));
    else
      yield* diffSnapshot(configuration.stream, records, state, {
        covers: expiredAfter(retainedSince(scan.startedAt, this.retentionDays))
      });
  }
  #read(scan) {
    return validateRecords(this, scan.knowledge.events(this.knowledge).map((event) => this.record(event)), "Activity");
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
var DiscoverabilitySignalsStream = class extends KnowledgeActivityStream {
  name = "discoverabilitySignals";
  knowledge = new DiscoverabilitySignals();
  jsonSchema = {
    type: "object",
    description: "One source record per feature-discovery signal on this Mac (knowledgeC /discoverability/signals), the events macOS uses to time its tips. macOS keeps these for two years.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  record(event) {
    return {
      ...knowledgeEventRecord(event),
      signal: event.signal ?? null,
      bundleId: event.bundleId ?? null,
      osBuild: event.osBuild ?? null,
      userInfo: plistText(event.userInfo)
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
var DisplayBacklightStream = class extends KnowledgeActivityStream {
  name = "displayBacklight";
  knowledge = new DisplayIsBacklit();
  jsonSchema = {
    type: "object",
    description: "One source record per span the display stayed lit or dark on this Mac (knowledgeC /display/isBacklit): when the screen was on.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  record(event) {
    return {
      ...knowledgeEventRecord(event),
      backlit: event.backlit ?? null
    };
  }
};

// packages/sources/apple/activity/dist/streams/document-interactions-stream.js
var { text: text5 } = activityFields;
var properties8 = {
  ...biomeAddress,
  interactionType: {
    ...activityFields.integer,
    description: "Biome document interaction type as stored (1 observed)."
  },
  path: { ...text5, description: "Path of the document." },
  contentType: {
    ...text5,
    description: "Uniform type identifier of the document, such as com.adobe.pdf."
  },
  bundleId: {
    ...activityFields.bundleId,
    description: "Bundle identifier of the app the document was used in."
  },
  appUrl: { ...text5, description: "File URL of that app." }
};
var DocumentInteractionsStream = class extends BiomeActivityStream {
  name = "documentInteractions";
  biome = new AppDocumentInteraction();
  jsonSchema = {
    type: "object",
    description: "One source record per document an app opened or used on this Mac (Biome App.DocumentInteraction). The file\u2019s bookmark data stays in payload.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  record(event, address) {
    return {
      ...address,
      interactionType: event.interactionType ?? null,
      path: event.path,
      contentType: event.contentType,
      bundleId: event.bundleId,
      appUrl: event.appUrl
    };
  }
};

// packages/sources/apple/activity/dist/streams/focus-modes-stream.js
var { text: text6, integer: integerField3 } = activityFields;
var properties9 = {
  ...biomeAddress,
  modeId: {
    ...text6,
    description: "Identifier of the configured Focus, a UUID."
  },
  semanticModeId: {
    ...text6,
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
var FocusModesStream = class extends BiomeActivityStream {
  name = "focusModes";
  biome = new UserFocusComputedMode();
  jsonSchema = {
    type: "object",
    description: "One source record per Focus turning on or off on this Mac (Biome UserFocus.ComputedMode).",
    properties: properties9,
    required: Object.keys(properties9)
  };
  record(event, address) {
    return {
      ...address,
      modeId: event.modeId,
      semanticModeId: event.semanticModeId,
      started: event.started ?? null,
      semanticType: event.semanticType ?? null,
      updateReason: event.updateReason ?? null,
      updateSource: event.updateSource ?? null
    };
  }
};

// packages/sources/apple/activity/dist/streams/focus-suggestions-stream.js
var { text: text7, nullableText: nullableText6, integer: integerField4 } = activityFields;
var properties10 = {
  ...biomeAddress,
  suggestionId: {
    ...text7,
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
var FocusSuggestionsStream = class extends BiomeActivityStream {
  name = "focusSuggestions";
  biome = new UserFocusInferredMode();
  jsonSchema = {
    type: "object",
    description: "One source record per start or end of a Focus the system inferred and suggested on this Mac (Biome UserFocus.InferredMode).",
    properties: properties10,
    required: Object.keys(properties10)
  };
  record(event, address) {
    return {
      ...address,
      suggestionId: event.suggestionId,
      occurredAt: isoTime(event.occurredAt),
      started: event.started ?? null,
      modeId: event.modeId ?? null,
      modeName: event.modeName ?? null,
      modeType: event.modeType ?? null,
      origin: event.origin ?? null,
      automationEnabled: event.automationEnabled ?? null,
      uiLocation: event.uiLocation ?? null,
      confidence: event.confidence,
      shouldSuggestTriggers: event.shouldSuggestTriggers ?? null,
      triggers: plistText(event.triggers)
    };
  }
};

// packages/sources/apple/activity/dist/streams/knowledge-intents-stream.js
var { text: text8, nullableText: nullableText7, integer: integerField5 } = activityFields;
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
    ...text8,
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
    ...text8,
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
var KnowledgeIntentsStream = class extends KnowledgeActivityStream {
  name = "knowledgeIntents";
  knowledge = new AppIntents();
  jsonSchema = {
    type: "object",
    description: "One source record per app interaction in knowledgeC (/app/intents), such as a message or call in a messaging app. On a Mac these arrive from the user\u2019s iPhone through knowledge sync.",
    properties: properties11,
    required: Object.keys(properties11)
  };
  record(event) {
    return {
      ...knowledgeEventRecord(event),
      category: event.category ?? null,
      bundleId: event.bundleId,
      deviceId: event.deviceId ?? null,
      itemId: event.itemId ?? null,
      groupId: event.groupId ?? null,
      intentClass: event.intentClass,
      intentVerb: event.intentVerb ?? null,
      intentType: event.intentType ?? null,
      handlingStatus: event.handlingStatus ?? null,
      direction: event.direction ?? null,
      donatedBySiri: event.donatedBySiri ?? null,
      interactionId: event.interactionId,
      derivedIntentId: event.derivedIntentId ?? null,
      relatedContactIds: event.relatedContactIds ?? null,
      interaction: plistText(event.interaction)
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
var MediaUsageStream = class extends BiomeActivityStream {
  name = "mediaUsage";
  biome = new AppMediaUsage();
  jsonSchema = {
    type: "object",
    description: "One source record per start or stop of media an app played on this Mac, as Screen Time counts it (Biome App.MediaUsage).",
    properties: properties12,
    required: Object.keys(properties12)
  };
  record(event, address) {
    return {
      ...address,
      usageId: event.usageId,
      started: event.started ?? null,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      usageTrusted: event.usageTrusted ?? null
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
var NotificationDeliveriesStream = class extends BiomeActivityStream {
  name = "notificationDeliveries";
  biome = new NotificationDelivery();
  jsonSchema = {
    type: "object",
    description: "One source record per notification delivered on this Mac (Biome Notification.Delivery). macOS keeps these for three days.",
    properties: properties13,
    required: Object.keys(properties13)
  };
  record(event, address) {
    return {
      ...address,
      requestId: event.requestId,
      bundleId: event.bundleId,
      occurredAt: isoTime(event.occurredAt)
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
var NotificationUsageStream = class extends BiomeActivityStream {
  name = "notificationUsage";
  biome = new NotificationUsage();
  jsonSchema = {
    type: "object",
    description: "One source record per notification event on this Mac (Biome Notification.Usage): which app notified, and when. Biome keeps no title or body here.",
    properties: properties14,
    required: Object.keys(properties14)
  };
  record(event, address) {
    return {
      ...address,
      notificationId: event.notificationId,
      occurredAt: isoTime(event.occurredAt),
      usageType: event.usageType ?? null,
      bundleId: event.bundleId
    };
  }
};

// packages/sources/apple/activity/dist/streams/now-playing-stream.js
var { nullableText: nullableText8, nullableInteger: nullableInteger3 } = activityFields;
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
var NowPlayingStream = class extends BiomeActivityStream {
  name = "nowPlaying";
  biome = new MediaNowPlaying();
  jsonSchema = {
    type: "object",
    description: "One source record per Now Playing change on this Mac and the devices it syncs with (Biome Media.NowPlaying): what played, in which app, and whether it played, paused or stopped.",
    properties: properties15,
    required: Object.keys(properties15)
  };
  record(event, address) {
    return {
      ...address,
      occurredAt: isoTime(event.occurredAt),
      playbackState: event.playbackState ?? null,
      title: event.title ?? null,
      artist: event.artist ?? null,
      album: event.album ?? null,
      durationSeconds: event.durationSeconds ?? null,
      mediaType: event.mediaType ?? null,
      airPlayVideo: event.airPlayVideo ?? null,
      bundleId: event.bundleId ?? null,
      outputDeviceIds: event.outputDeviceIds
    };
  }
};

// packages/sources/apple/activity/dist/streams/safari-navigations-stream.js
var { text: text9 } = activityFields;
var properties16 = {
  ...biomeAddress,
  host: { ...text9, description: "Host of the page navigated to." },
  url: { ...text9, description: "URL of the page navigated to." },
  countryCode: {
    ...text9,
    description: "Two-letter country code Biome stores with the navigation."
  },
  periodEndsAt: {
    ...activityFields.timestamp,
    description: "The navigation time rounded up to the next half hour, as stored; recordedAt is the exact time."
  }
};
var SafariNavigationsStream = class extends BiomeActivityStream {
  name = "safariNavigations";
  biome = new SafariNavigations();
  jsonSchema = {
    type: "object",
    description: "One source record per page navigation Safari reports to Biome on this Mac (Biome Safari.Navigations). Clearing Safari history deletes these records. Its other fields are unnamed and stay in payload.",
    properties: properties16,
    required: Object.keys(properties16)
  };
  record(event, address) {
    return {
      ...address,
      host: event.host,
      url: event.url,
      countryCode: event.countryCode,
      periodEndsAt: isoTime(event.periodEndsAt)
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
var ScreenTimeAppUsageStream = class extends BiomeActivityStream {
  name = "screenTimeAppUsage";
  biome = new ScreenTimeAppUsage();
  jsonSchema = {
    type: "object",
    description: "One source record per start or end of app usage that Screen Time counts (Biome ScreenTime.AppUsage) on this Mac. It follows appFocus without system interface such as the Dock or the login window.",
    properties: properties17,
    required: Object.keys(properties17)
  };
  record(event, address) {
    return {
      ...address,
      started: event.started ?? null,
      occurredAt: isoTime(event.occurredAt),
      bundleId: event.bundleId,
      usageTrusted: event.usageTrusted ?? null
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
var ScreenshotsStream = class extends BiomeActivityStream {
  name = "screenshots";
  biome = new ScreenshotsScreenshot();
  jsonSchema = {
    type: "object",
    description: "One source record per screenshot taken on this Mac (Biome Screenshots.Screenshot). macOS keeps these for one day.",
    properties: properties18,
    required: Object.keys(properties18)
  };
  record(event, address) {
    return {
      ...address,
      path: event.path ?? null,
      screenshotSource: event.screenshotSource ?? null,
      screenshotLocation: event.screenshotLocation ?? null,
      screenshotStyle: event.screenshotStyle ?? null
    };
  }
};

// packages/sources/apple/activity/dist/streams/web-usage-stream.js
var { text: text10 } = activityFields;
var properties19 = {
  ...biomeAddress,
  usageId: {
    ...text10,
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
  url: { ...text10, description: "The page URL." },
  domain: { ...text10, description: "The web domain Screen Time counts." },
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
var WebUsageStream = class extends BiomeActivityStream {
  name = "webUsage";
  biome = new AppWebUsage();
  jsonSchema = {
    type: "object",
    description: "One source record per change of a web page\u2019s usage that Screen Time counts on this Mac (Biome App.WebUsage). Clearing browsing history deletes these records.",
    properties: properties19,
    required: Object.keys(properties19)
  };
  record(event, address) {
    return {
      ...address,
      usageId: event.usageId,
      occurredAt: isoTime(event.occurredAt),
      usageState: event.usageState ?? null,
      url: event.url,
      domain: event.domain,
      bundleId: event.bundleId,
      usageTrusted: event.usageTrusted ?? null,
      safariProfileId: event.safariProfileId ?? null
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
  constructor({ biome = biomeDirectory, knowledge = knowledgeStorePath, pollIntervalMs = 6e4 } = {}) {
    super();
    this.location = Object.freeze({ biome, knowledge });
    this.pollIntervalMs = pollIntervalMs;
    this.identity = `apple-activity:${biome}:${knowledge}`;
    Object.freeze(this);
  }
  open(streams) {
    return ActivityScan.open(this.location, new Set(streams.map((stream) => readerOf(stream).store)));
  }
  failureType(error) {
    return error instanceof BiomeUnavailableError || error instanceof KnowledgeUnavailableError ? "config" : "system";
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
  // segment's fingerprint does. Databases report commits through data_version.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const versions = __using(_stack, new DisposableStack());
      const biome = new BiomeStore(this.location.biome);
      const databases = {
        knowledge: () => new KnowledgeStore(this.location.knowledge).version(),
        devices: () => biome.syncVersion()
      };
      const probes = /* @__PURE__ */ new Map();
      const opened = /* @__PURE__ */ new Map();
      for (const stream of streams) {
        const reader = readerOf(stream);
        if (reader.store === "biome") {
          probes.set(stream, () => biome.version(reader.biome));
          continue;
        }
        let probe = opened.get(reader.store);
        if (probe === void 0) {
          const version = versions.use(databases[reader.store]());
          probe = async () => String(version.current);
          opened.set(reader.store, probe);
        }
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
