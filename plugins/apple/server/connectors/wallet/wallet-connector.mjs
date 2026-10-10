import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  isDictionary,
  readPlist
} from "../../chunks/chunk-QPPOHR2G.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppDatabase,
  AppDatabaseVersion,
  referenceDateInstant
} from "../../chunks/chunk-DV4S52G7.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-QNQLFEII.mjs";
import "../../chunks/chunk-YZBCNEVG.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-2UKXR4JG.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/wallet/dist/apple-wallet-source.js
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/wallet/dist/errors.js
var WalletUnavailableError = class extends Error {
  name = "WalletUnavailableError";
  constructor(path, cause) {
    super(`The Wallet store at ${path} cannot be read.`, { cause });
  }
};
var WalletSchemaError = class extends Error {
  name = "WalletSchemaError";
  constructor(path, missing) {
    super(`The Wallet store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};
var PassBundleError = class extends Error {
  name = "PassBundleError";
  constructor(id9, directory, cause) {
    super(`The bundle of pass ${id9} at ${directory} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
};

// packages/sdks/apple/wallet/dist/pass-json.js
var PassNumber = class {
  text;
  constructor(text7) {
    this.text = text7;
  }
};
function parsePassJson(text7) {
  return passJson(JSON.parse(text7, (_key, value, context) => typeof value === "number" && context?.source !== void 0 ? new PassNumber(context.source) : value));
}
function passJsonText(value) {
  if (value instanceof PassNumber)
    return value.text;
  if (isPassList(value))
    return `[${value.map(passJsonText).join(",")}]`;
  if (isPassObject(value))
    return `{${Object.entries(value).map(([key, field]) => `${JSON.stringify(key)}:${passJsonText(field)}`).join(",")}}`;
  return JSON.stringify(value);
}
function isPassObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof PassNumber);
}
function isPassList(value) {
  return Array.isArray(value);
}
function passJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || value instanceof PassNumber)
    return value;
  if (Array.isArray(value))
    return value.map(passJson);
  if (typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, passJson(field)]));
  throw new TypeError(`JSON parsing returned a ${typeof value}`);
}

// packages/sdks/apple/wallet/dist/wallet-store.js
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// packages/sdks/apple/wallet/dist/pass-bundle.js
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// packages/sdks/apple/wallet/dist/pass.js
var passStyles = [
  "boardingPass",
  "coupon",
  "eventTicket",
  "generic",
  "storeCard"
];

// packages/sdks/apple/wallet/dist/pass-content.js
var w3cDate = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/;
var PassReader = class _PassReader {
  #object;
  #path;
  constructor(object, path) {
    this.#object = object;
    this.#path = path;
  }
  has(key) {
    return this.#object[key] !== void 0 && this.#object[key] !== null;
  }
  text(key) {
    const value = this.#object[key];
    if (value === void 0 || value === null)
      return null;
    if (typeof value !== "string")
      throw this.#wrong(key, "text");
    return value;
  }
  requiredText(key) {
    return this.text(key) ?? this.#missing(key);
  }
  // Text or a number, as pass.json spells it.
  value(key) {
    const value = this.#object[key];
    if (value instanceof PassNumber)
      return value.text;
    return this.text(key);
  }
  requiredValue(key) {
    return this.value(key) ?? this.#missing(key);
  }
  flag(key) {
    const value = this.#object[key];
    if (value === void 0 || value === null)
      return false;
    if (typeof value !== "boolean")
      throw this.#wrong(key, "a boolean");
    return value;
  }
  number(key) {
    const value = this.#object[key];
    if (value === void 0 || value === null)
      return null;
    if (!(value instanceof PassNumber))
      throw this.#wrong(key, "a number");
    return Number(value.text);
  }
  requiredNumber(key) {
    return this.number(key) ?? this.#missing(key);
  }
  integer(key) {
    const value = this.number(key);
    if (value !== null && !Number.isSafeInteger(value))
      throw this.#wrong(key, "an integer");
    return value;
  }
  requiredInteger(key) {
    return this.integer(key) ?? this.#missing(key);
  }
  date(key) {
    const text7 = this.text(key);
    return text7 === null ? null : this.#date(key, text7);
  }
  json(key) {
    return this.#object[key] ?? null;
  }
  texts(key) {
    if (!this.has(key))
      return null;
    return this.#list(key).map((item, index) => {
      if (typeof item !== "string")
        throw this.#wrong(`${key}[${index}]`, "text");
      return item;
    });
  }
  integers(key) {
    if (!this.has(key))
      return null;
    return this.#list(key).map((item, index) => {
      const value = item instanceof PassNumber ? Number(item.text) : null;
      if (value === null || !Number.isSafeInteger(value))
        throw this.#wrong(`${key}[${index}]`, "an integer");
      return value;
    });
  }
  object(key) {
    const value = this.#object[key];
    if (!isPassObject(value))
      throw this.#wrong(key, "an object");
    return new _PassReader(value, `${this.#path}.${key}`);
  }
  objects(key) {
    if (!this.has(key))
      return [];
    return this.#list(key).map((item, index) => {
      if (!isPassObject(item))
        throw this.#wrong(`${key}[${index}]`, "an object");
      return new _PassReader(item, `${this.#path}.${key}[${index}]`);
    });
  }
  // The keys that name an area of fields, such as primaryFields.
  fieldAreas() {
    return Object.keys(this.#object).filter((key) => key.endsWith("Fields") && isPassList(this.#object[key]));
  }
  #list(key) {
    const value = this.#object[key];
    if (!isPassList(value))
      throw this.#wrong(key, "a list");
    return value;
  }
  #date(key, text7) {
    const match = w3cDate.exec(text7);
    if (match === null)
      throw this.#wrong(key, "a W3C date with a time zone");
    const [year, month, day, hour, minute, second, fraction] = match.slice(1, 8).map((part) => part ?? "");
    const sign = match[8] === "-" ? -1 : 1;
    const offsetMinutes = match[8] === void 0 ? 0 : sign * (Number(match[9]) * 60 + Number(match[10]));
    const wall = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(fraction?.padEnd(3, "0")));
    if (new Date(wall).toISOString().slice(0, 16) !== `${year}-${month}-${day}T${hour}:${minute}`)
      throw this.#wrong(key, "a calendar date");
    return {
      at: new Date(wall - offsetMinutes * 6e4).toISOString(),
      offsetMinutes
    };
  }
  #missing(key) {
    throw new TypeError(`${this.#path}.${key} is missing`);
  }
  #wrong(key, kind) {
    return new TypeError(`${this.#path}.${key} is not ${kind}`);
  }
};
function passContent(json2) {
  if (!isPassObject(json2))
    throw new TypeError("pass.json is not an object");
  const pass = new PassReader(json2, "pass.json");
  const style = passStyles.find((name) => isPassObject(json2[name])) ?? null;
  const structure = style === null ? null : pass.object(style);
  return {
    passTypeIdentifier: pass.requiredText("passTypeIdentifier"),
    serialNumber: pass.requiredText("serialNumber"),
    teamIdentifier: pass.requiredText("teamIdentifier"),
    organizationName: pass.requiredText("organizationName"),
    description: pass.requiredText("description"),
    formatVersion: pass.requiredInteger("formatVersion"),
    logoText: pass.text("logoText"),
    style,
    transitType: structure?.text("transitType") ?? null,
    groupingIdentifier: pass.text("groupingIdentifier"),
    relevantDate: pass.date("relevantDate"),
    expirationDate: pass.date("expirationDate"),
    voided: pass.flag("voided"),
    maxDistance: pass.number("maxDistance"),
    associatedStoreIdentifiers: pass.integers("associatedStoreIdentifiers"),
    appLaunchUrl: pass.text("appLaunchURL"),
    webServiceUrl: pass.text("webServiceURL"),
    sharingProhibited: pass.flag("sharingProhibited"),
    foregroundColor: pass.text("foregroundColor"),
    backgroundColor: pass.text("backgroundColor"),
    labelColor: pass.text("labelColor"),
    semantics: pass.json("semantics"),
    userInfo: pass.json("userInfo"),
    fields: structure === null ? [] : fields(structure),
    barcodes: barcodes(pass),
    locations: pass.objects("locations").map(location),
    beacons: pass.objects("beacons").map(beacon),
    relevantDates: pass.objects("relevantDates").map(relevantDate),
    json: Object.fromEntries(Object.entries(json2).filter(([key]) => key !== "authenticationToken"))
  };
}
function fields(structure) {
  return structure.fieldAreas().flatMap((key) => structure.objects(key).map((field, position) => ({
    area: key.slice(0, -"Fields".length),
    position,
    key: field.requiredText("key"),
    label: field.text("label"),
    value: field.requiredValue("value"),
    attributedValue: field.value("attributedValue"),
    changeMessage: field.text("changeMessage"),
    textAlignment: field.text("textAlignment"),
    dateStyle: field.text("dateStyle"),
    timeStyle: field.text("timeStyle"),
    ignoresTimeZone: field.flag("ignoresTimeZone"),
    isRelative: field.flag("isRelative"),
    numberStyle: field.text("numberStyle"),
    currencyCode: field.text("currencyCode"),
    dataDetectorTypes: field.texts("dataDetectorTypes"),
    row: field.integer("row"),
    semantics: field.json("semantics")
  })));
}
function barcodes(pass) {
  return barcodeReaders(pass).map((barcode, position) => ({
    position,
    format: barcode.requiredText("format"),
    message: barcode.requiredText("message"),
    messageEncoding: barcode.requiredText("messageEncoding"),
    altText: barcode.text("altText")
  }));
}
function barcodeReaders(pass) {
  if (pass.has("barcodes"))
    return pass.objects("barcodes");
  if (pass.has("barcode"))
    return [pass.object("barcode")];
  return [];
}
function location(location2, position) {
  return {
    position,
    latitude: location2.requiredNumber("latitude"),
    longitude: location2.requiredNumber("longitude"),
    altitude: location2.number("altitude"),
    relevantText: location2.text("relevantText")
  };
}
function beacon(beacon2, position) {
  return {
    position,
    proximityUuid: beacon2.requiredText("proximityUUID"),
    major: beacon2.integer("major"),
    minor: beacon2.integer("minor"),
    relevantText: beacon2.text("relevantText")
  };
}
function relevantDate(relevant, position) {
  return {
    position,
    date: relevant.date("date"),
    startDate: relevant.date("startDate"),
    endDate: relevant.date("endDate")
  };
}

// packages/sdks/apple/wallet/dist/pass-bundle.js
var stringsPath = /^(?<language>[^/]+)\.lproj\/pass\.strings$/;
var imagePath = /^(?:(?<language>[^/]+)\.lproj\/)?(?<name>.+?)(?:@(?<scale>\d+)x)?\.png$/i;
async function readPassBundle(id9, directory) {
  try {
    const manifest = await json(join(directory, "manifest.json"));
    if (!isPassObject(manifest))
      throw new TypeError("manifest.json is not an object");
    const content = passContent(await json(join(directory, "pass.json")));
    const strings = [];
    const images = [];
    let personalization = null;
    for (const [path, sha1] of Object.entries(manifest)) {
      if (typeof sha1 !== "string")
        throw new TypeError(`manifest.json gives ${path} no SHA-1`);
      const file = join(directory, path);
      const localized = stringsPath.exec(path)?.groups;
      const image = imagePath.exec(path)?.groups;
      if (localized?.language !== void 0)
        strings.push(...await passStrings(file, localized.language));
      else if (image?.name !== void 0)
        images.push({
          path,
          file,
          name: image.name,
          scale: Number(image.scale ?? 1),
          language: image.language ?? null,
          sha1
        });
      else if (path === "personalization.json")
        personalization = await json(file);
    }
    return { ...content, strings, images, personalization };
  } catch (cause) {
    throw new PassBundleError(id9, directory, cause);
  }
}
async function json(path) {
  return parsePassJson(await readFile(path, "utf8"));
}
async function passStrings(file, language) {
  const table = await readPlist(file);
  if (!isDictionary(table))
    throw new TypeError(`${language}.lproj/pass.strings is not a table`);
  return Object.entries(table).map(([key, text7]) => {
    if (typeof text7 !== "string")
      throw new TypeError(`${language}.lproj/pass.strings gives ${key} no text`);
    return { language, key, text: text7 };
  });
}

// packages/sdks/apple/wallet/dist/wallet-records.js
var requiredColumns = {
  pass: ["pid", "unique_id", "ingested_date", "modified_date", "signing_date"],
  pass_annotations: ["pass_pid", "sorting_state", "archived_timestamp"]
};
function walletRecords(path) {
  var _stack = [];
  try {
    const database = __using(_stack, new AppDatabase(path, WalletUnavailableError));
    database.requireColumns(requiredColumns, WalletSchemaError);
    return database.all(`SELECT pass.unique_id AS id,
              pass.ingested_date AS addedAt,
              pass.modified_date AS updatedAt,
              pass.signing_date AS signedAt,
              pass_annotations.archived_timestamp AS archivedAt,
              pass_annotations.sorting_state AS sortingState
       FROM pass
       LEFT JOIN pass_annotations ON pass_annotations.pass_pid = pass.pid
       ORDER BY pass.ingested_date, pass.unique_id`).map((row) => {
      if (typeof row.id !== "string")
        throw new TypeError("A Wallet pass has no unique ID");
      return {
        id: row.id,
        addedAt: instant(row.addedAt),
        updatedAt: instant(row.updatedAt),
        signedAt: instant(row.signedAt),
        archivedAt: instant(row.archivedAt),
        sortingState: row.sortingState === null ? null : Number(row.sortingState)
      };
    });
  } catch (_) {
    var _error = _, _hasError = true;
  } finally {
    __callDispose(_stack, _error, _hasError);
  }
}
function instant(value) {
  return value === null ? null : referenceDateInstant(Number(value));
}

// packages/sdks/apple/wallet/dist/wallet-store.js
var walletStorePath = join2(homedir(), "Library/Passes");
var WalletStore = class {
  #directory;
  constructor(directory) {
    this.#directory = directory;
  }
  get #database() {
    return join2(this.#directory, "passes23.sqlite");
  }
  // Every pass Wallet holds. The bundles are read after the database closes,
  // one at a time, so a large Wallet never holds many files open.
  async passes() {
    const passes = [];
    for (const record of walletRecords(this.#database))
      passes.push({
        ...record,
        ...await readPassBundle(record.id, join2(this.#directory, "Cards", `${record.id}.pkpass`))
      });
    return passes;
  }
  // A probe whose current value changes with each commit to the database,
  // such as passd adding, updating, archiving or removing a pass.
  version() {
    return new AppDatabaseVersion(this.#database, WalletUnavailableError);
  }
};

// packages/sources/apple/wallet/dist/apple-wallet-stream.js
var walletFields = {
  ...eventKitFields,
  nullableInteger: { type: ["integer", "null"] },
  nullableNumber: { type: ["number", "null"] },
  nullableTextList: { type: ["array", "null"], items: { type: "string" } },
  // passd's own dates, doubles that resolve below a microsecond.
  walletInstant: {
    type: ["string", "null"],
    format: "date-time",
    precision: 6
  },
  // pass.json's W3C dates, which PassKit reads to the millisecond.
  passInstant: { type: ["string", "null"], format: "date-time" },
  offset: { type: ["integer", "null"], minimum: -1440, maximum: 1440 }
};
var AppleWalletStream = class {
  supportedSyncModes = Object.freeze([
    "full_refresh",
    "incremental"
  ]);
  // Every read is every pass Wallet holds, so incremental copies diff
  // snapshots, and a pass the user removed is deleted.
  sourceDefinedCursor = true;
  emitsDeletes = true;
  #stream;
  describe() {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }
  read(scan) {
    return validateRecords(this, scan.passes.flatMap((pass) => this.records(pass)), "Wallet");
  }
  // The file a record carries, for streams that support file reads.
  file(_record) {
    return null;
  }
};

// packages/sources/apple/wallet/dist/streams/pass-barcodes-stream.js
var { id, text, nullableText, ordinal } = walletFields;
var properties = {
  passId: { ...id, description: "The pass it is on; refers to passes.id." },
  position: {
    ...ordinal,
    description: "Its place among the pass\u2019s barcodes, from 0; Wallet shows the first one the device can draw."
  },
  format: {
    ...text,
    description: "The kind of barcode (format), such as PKBarcodeFormatQR, PKBarcodeFormatPDF417, PKBarcodeFormatAztec or PKBarcodeFormatCode128."
  },
  message: {
    ...text,
    description: "What the barcode encodes (message), what a scanner at a gate or a till reads: a boarding pass\u2019s booking data, a ticket\u2019s or card\u2019s number."
  },
  messageEncoding: {
    ...text,
    description: "The text encoding the barcode carries message in (messageEncoding), such as iso-8859-1."
  },
  altText: {
    ...nullableText,
    description: "The text Wallet shows under the barcode (altText); NULL when it shows none."
  }
};
var PassBarcodesStream = class extends AppleWalletStream {
  name = "passBarcodes";
  primaryKey = ["passId", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per barcode a pass offers, from its barcodes list, or its single barcode when a pass made before iOS 9 has no list. Primary key passId, position.",
    properties,
    required: Object.keys(properties)
  };
  records(pass) {
    return pass.barcodes.map((barcode) => ({ passId: pass.id, ...barcode }));
  }
};

// packages/sources/apple/wallet/dist/streams/pass-beacons-stream.js
var { id: id2, text: text2, nullableText: nullableText2, ordinal: ordinal2 } = walletFields;
var uint16 = {
  type: ["integer", "null"],
  minimum: 0,
  maximum: 65535
};
var properties2 = {
  passId: { ...id2, description: "The pass it is for; refers to passes.id." },
  position: {
    ...ordinal2,
    description: "Its place in the pass\u2019s beacons, from 0."
  },
  proximityUuid: {
    ...text2,
    description: "The Bluetooth beacon\u2019s proximity UUID (proximityUUID)."
  },
  major: {
    ...uint16,
    description: "The beacon\u2019s major identifier (major); NULL when any major matches."
  },
  minor: {
    ...uint16,
    description: "The beacon\u2019s minor identifier (minor); NULL when any minor matches."
  },
  relevantText: {
    ...nullableText2,
    description: "What the Lock Screen says when the beacon is near (relevantText); NULL when the pass says nothing."
  }
};
var PassBeaconsStream = class extends AppleWalletStream {
  name = "passBeacons";
  primaryKey = ["passId", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per Bluetooth beacon near which Wallet offers a pass on the Lock Screen, such as a store\u2019s. Primary key passId, position.",
    properties: properties2,
    required: Object.keys(properties2)
  };
  records(pass) {
    return pass.beacons.map((beacon2) => ({ passId: pass.id, ...beacon2 }));
  }
};

// packages/sources/apple/wallet/dist/streams/pass-fields-stream.js
var { id: id3, text: text3, nullableText: nullableText3, ordinal: ordinal3, boolean, nullableInteger, nullableTextList } = walletFields;
var properties3 = {
  passId: { ...id3, description: "The pass it is on; refers to passes.id." },
  area: {
    ...id3,
    description: 'Where the pass shows it, the pass.json array it is in without "Fields": header, primary, secondary, auxiliary, back (behind the pass) or additionalInfo.'
  },
  position: {
    ...ordinal3,
    description: "Its place in its area, from 0, in pass.json\u2019s order."
  },
  key: {
    ...id3,
    description: "The issuer\u2019s name for the field (key), such as boarding-gate or seat."
  },
  label: {
    ...nullableText3,
    description: "The text above the value (label), such as GATE, or its localization key: passLocalizations holds each language\u2019s text. NULL when the field shows none."
  },
  value: {
    ...text3,
    description: "What the field shows (value) as pass.json writes it: text or its localization key, a number\u2019s digits, or a W3C date that dateStyle and timeStyle format."
  },
  attributedValue: {
    ...nullableText3,
    description: "The value with HTML links that Wallet shows behind the pass (attributedValue); NULL when the field has none."
  },
  changeMessage: {
    ...nullableText3,
    description: "The notification Wallet shows when an update changes the value (changeMessage), %@ standing for the new value; NULL when the change is silent."
  },
  textAlignment: {
    ...nullableText3,
    description: "How the field is aligned (textAlignment), such as PKTextAlignmentRight; NULL for Wallet\u2019s default."
  },
  dateStyle: {
    ...nullableText3,
    description: "How Wallet shows the date in value (dateStyle), such as PKDateStyleShort; NULL when value is not shown as a date."
  },
  timeStyle: {
    ...nullableText3,
    description: "How Wallet shows the time in value (timeStyle); NULL when value is not shown as a time."
  },
  ignoresTimeZone: {
    ...boolean,
    description: "Whether Wallet shows the date in the time zone it was written in rather than the device\u2019s (ignoresTimeZone)."
  },
  isRelative: {
    ...boolean,
    description: "Whether Wallet shows the date relative to now, such as in 2 hours (isRelative)."
  },
  numberStyle: {
    ...nullableText3,
    description: "How Wallet shows the number in value (numberStyle), such as PKNumberStylePercent; NULL when it shows none."
  },
  currencyCode: {
    ...nullableText3,
    description: "The ISO 4217 currency Wallet shows value in (currencyCode); NULL when value is no amount."
  },
  dataDetectorTypes: {
    ...nullableTextList,
    description: "What Wallet turns into links in a value behind the pass (dataDetectorTypes), such as PKDataDetectorTypeLink; NULL for Wallet\u2019s default."
  },
  row: {
    ...nullableInteger,
    description: "For an auxiliary field of an event ticket, the row it is in (row), 0 or 1; NULL otherwise."
  },
  semantics: {
    ...nullableText3,
    description: "The field\u2019s semantic tags (semantics) as JSON; NULL when it carries none."
  }
};
var PassFieldsStream = class extends AppleWalletStream {
  name = "passFields";
  primaryKey = ["passId", "area", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per field a pass shows, on its front or behind it: a flight\u2019s gate and seat, a ticket\u2019s date and location, a card\u2019s balance. Primary key passId, area, position.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  records(pass) {
    return pass.fields.map((field) => ({
      passId: pass.id,
      area: field.area,
      position: field.position,
      key: field.key,
      label: field.label,
      value: field.value,
      attributedValue: field.attributedValue,
      changeMessage: field.changeMessage,
      textAlignment: field.textAlignment,
      dateStyle: field.dateStyle,
      timeStyle: field.timeStyle,
      ignoresTimeZone: field.ignoresTimeZone,
      isRelative: field.isRelative,
      numberStyle: field.numberStyle,
      currencyCode: field.currencyCode,
      dataDetectorTypes: field.dataDetectorTypes,
      row: field.row,
      semantics: field.semantics === null ? null : passJsonText(field.semantics)
    }));
  }
};

// packages/sources/apple/wallet/dist/streams/pass-images-stream.js
var { id: id4, text: text4, nullableText: nullableText4 } = walletFields;
var properties4 = {
  passId: { ...id4, description: "The pass it is in; refers to passes.id." },
  path: {
    ...id4,
    description: "Its path in the pass bundle, such as strip@2x.png or en.lproj/logo.png."
  },
  name: {
    ...id4,
    description: "The image it is, its file name without scale and extension: icon, logo, strip, thumbnail, background, footer, or another the issuer added."
  },
  scale: {
    type: "integer",
    minimum: 1,
    description: "The screen scale it is drawn for: 1, or 2 and 3 for @2x and @3x files."
  },
  language: {
    ...nullableText4,
    description: "The language whose .lproj folder holds it; NULL for an image every language shows."
  },
  sha1: {
    ...text4,
    description: "The SHA-1 the bundle\u2019s signed manifest.json gives the file; it changes with the image."
  },
  file: {
    ...id4,
    description: "Where the image is on this Mac, in the bundle Wallet keeps; the image file is exported from it."
  }
};
var PassImagesStream = class extends AppleWalletStream {
  name = "passImages";
  primaryKey = ["passId", "path"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: "One record per image in a pass\u2019s bundle, with the image as its file: the logo and icon, and a strip, thumbnail or background that may show the event or the holder. Primary key passId, path.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  records(pass) {
    return pass.images.map((image) => ({ passId: pass.id, ...image }));
  }
  // The image in the bundle Wallet keeps, not a copy: it stays until the pass
  // changes, and readers only read it.
  file({ file }) {
    return typeof file === "string" ? file : null;
  }
};

// packages/sources/apple/wallet/dist/streams/pass-localizations-stream.js
var { id: id5, text: text5 } = walletFields;
var properties5 = {
  passId: { ...id5, description: "The pass it is in; refers to passes.id." },
  language: {
    ...id5,
    description: "The language, as the bundle\u2019s <language>.lproj folder names it, such as en or pt-BR."
  },
  key: {
    ...text5,
    description: "The localization key, the text pass.json writes in its place: a field\u2019s label or value, the pass\u2019s description or logoText."
  },
  text: {
    ...text5,
    description: "What Wallet shows for key in this language."
  }
};
var PassLocalizationsStream = class extends AppleWalletStream {
  name = "passLocalizations";
  primaryKey = ["passId", "language", "key"];
  jsonSchema = {
    type: "object",
    description: "One record per text a pass translates, from each <language>.lproj/pass.strings in its bundle. Wallet shows a key\u2019s text in the device\u2019s language; join on passId and key to read a pass in a language. Primary key passId, language, key.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  records(pass) {
    return pass.strings.map((entry) => ({ passId: pass.id, ...entry }));
  }
};

// packages/sources/apple/wallet/dist/streams/pass-locations-stream.js
var { id: id6, nullableText: nullableText5, ordinal: ordinal4, nullableNumber } = walletFields;
var properties6 = {
  passId: { ...id6, description: "The pass it is for; refers to passes.id." },
  position: {
    ...ordinal4,
    description: "Its place in the pass\u2019s locations, from 0."
  },
  latitude: {
    type: "number",
    minimum: -90,
    maximum: 90,
    description: "Latitude in degrees (latitude)."
  },
  longitude: {
    type: "number",
    minimum: -180,
    maximum: 180,
    description: "Longitude in degrees (longitude)."
  },
  altitude: {
    ...nullableNumber,
    description: "Altitude in meters (altitude); NULL when not given."
  },
  relevantText: {
    ...nullableText5,
    description: "What the Lock Screen says when the holder is near (relevantText); NULL when the pass says nothing."
  }
};
var PassLocationsStream = class extends AppleWalletStream {
  name = "passLocations";
  primaryKey = ["passId", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per place where Wallet offers a pass on the Lock Screen, such as a store or a venue. Primary key passId, position.",
    properties: properties6,
    required: Object.keys(properties6)
  };
  records(pass) {
    return pass.locations.map((location2) => ({
      passId: pass.id,
      ...location2
    }));
  }
};

// packages/sources/apple/wallet/dist/streams/pass-relevant-dates-stream.js
var { id: id7, ordinal: ordinal5, passInstant, offset } = walletFields;
var properties7 = {
  passId: { ...id7, description: "The pass it is for; refers to passes.id." },
  position: {
    ...ordinal5,
    description: "Its place in the pass\u2019s relevantDates, from 0."
  },
  at: {
    ...passInstant,
    description: "The moment the pass is relevant (date), in UTC; NULL when the entry gives an interval instead."
  },
  atOffset: {
    ...offset,
    description: "The offset from UTC, in minutes, that date was written with; NULL when at is."
  },
  startsAt: {
    ...passInstant,
    description: "When the interval the pass is relevant in starts (startDate), in UTC; NULL when the entry gives a moment."
  },
  startsAtOffset: {
    ...offset,
    description: "The offset from UTC, in minutes, that startDate was written with; NULL when startsAt is."
  },
  endsAt: {
    ...passInstant,
    description: "When that interval ends (endDate), in UTC; NULL when the entry gives a moment."
  },
  endsAtOffset: {
    ...offset,
    description: "The offset from UTC, in minutes, that endDate was written with; NULL when endsAt is."
  }
};
var PassRelevantDatesStream = class extends AppleWalletStream {
  name = "passRelevantDates";
  primaryKey = ["passId", "position"];
  jsonSchema = {
    type: "object",
    description: "One record per time a pass made for iOS 18 or later says it is relevant (relevantDates), when Wallet offers it on the Lock Screen: a moment or an interval. Older passes give one moment, passes.relevantAt. Primary key passId, position.",
    properties: properties7,
    required: Object.keys(properties7)
  };
  records(pass) {
    return pass.relevantDates.map((relevant) => ({
      passId: pass.id,
      position: relevant.position,
      at: relevant.date?.at ?? null,
      atOffset: relevant.date?.offsetMinutes ?? null,
      startsAt: relevant.startDate?.at ?? null,
      startsAtOffset: relevant.startDate?.offsetMinutes ?? null,
      endsAt: relevant.endDate?.at ?? null,
      endsAtOffset: relevant.endDate?.offsetMinutes ?? null
    }));
  }
};

// packages/sources/apple/wallet/dist/streams/passes-stream.js
var { id: id8, text: text6, nullableText: nullableText6, integer, boolean: boolean2, nullableInteger: nullableInteger2, nullableNumber: nullableNumber2, walletInstant, passInstant: passInstant2, offset: offset2 } = walletFields;
var properties8 = {
  id: {
    ...id8,
    description: "passd\u2019s identifier for the pass (pass.unique_id), also the name of its bundle, ~/Library/Passes/Cards/<id>.pkpass. Every other Wallet stream\u2019s passId refers to it."
  },
  passTypeIdentifier: {
    ...text6,
    description: "The issuer\u2019s pass type (pass.json passTypeIdentifier), such as pass.com.qatarairways.qrmobile. With serialNumber, the issuer\u2019s identity for the pass; an update keeps both."
  },
  serialNumber: {
    ...text6,
    description: "The issuer\u2019s serial number for the pass within its type (serialNumber)."
  },
  teamIdentifier: {
    ...text6,
    description: "The Apple developer team that signed the pass (teamIdentifier)."
  },
  organizationName: {
    ...text6,
    description: "The issuer\u2019s name as the pass shows it (organizationName), or its localization key: passLocalizations holds each language\u2019s text."
  },
  description: {
    ...text6,
    description: "What the pass is, as VoiceOver reads it (description), such as Qatar Airways Boarding Pass, or its localization key."
  },
  logoText: {
    ...nullableText6,
    description: "The text beside the logo (logoText), or its localization key; NULL when the pass shows none."
  },
  style: {
    type: ["string", "null"],
    enum: ["boardingPass", "coupon", "eventTicket", "generic", "storeCard"],
    description: "The kind of pass, the pass.json key that holds its fields; NULL for a pass with none of them, such as a payment card."
  },
  transitType: {
    ...nullableText6,
    description: "For a boarding pass, how the holder travels (boardingPass.transitType), such as PKTransitTypeAir or PKTransitTypeTrain; NULL otherwise."
  },
  formatVersion: {
    ...integer,
    description: "The version of Apple\u2019s pass format (formatVersion); 1."
  },
  groupingIdentifier: {
    ...nullableText6,
    description: "Passes of one type with the same value (groupingIdentifier) stack together in Wallet, such as the boarding passes of one booking; NULL when the pass names none."
  },
  relevantAt: {
    ...passInstant2,
    description: "When the pass is relevant (relevantDate), such as a departure, in UTC; NULL when it names none. passRelevantDates holds the dates of passes made for iOS 18 and later."
  },
  relevantAtOffset: {
    ...offset2,
    description: "The offset from UTC, in minutes, that relevantDate was written with: the local time of the airport or venue. NULL when relevantAt is."
  },
  expiresAt: {
    ...passInstant2,
    description: "When the pass expires (expirationDate), in UTC; Wallet then shows it as expired. NULL when it does not expire."
  },
  expiresAtOffset: {
    ...offset2,
    description: "The offset from UTC, in minutes, that expirationDate was written with. NULL when expiresAt is."
  },
  voided: {
    ...boolean2,
    description: "Whether the issuer voided the pass (voided), such as a used ticket; false when pass.json leaves it out."
  },
  maxDistance: {
    ...nullableNumber2,
    description: "How close, in meters, the holder must be to one of passLocations for Wallet to show the pass (maxDistance); NULL for Wallet\u2019s default."
  },
  associatedStoreIdentifiers: {
    type: ["array", "null"],
    items: { type: "integer" },
    description: "The App Store IDs of the issuer\u2019s apps (associatedStoreIdentifiers); NULL when the pass names none."
  },
  appLaunchUrl: {
    ...nullableText6,
    description: "The URL Wallet passes to the issuer\u2019s app when it opens it from the pass (appLaunchURL); NULL when the pass names none."
  },
  webServiceUrl: {
    ...nullableText6,
    description: "The issuer\u2019s web service that sends Wallet new versions of the pass (webServiceURL); NULL when the pass never changes. The token it takes is not loaded."
  },
  sharingProhibited: {
    ...boolean2,
    description: "Whether Wallet hides the pass\u2019s share button (sharingProhibited)."
  },
  foregroundColor: {
    ...nullableText6,
    description: "The color of the pass\u2019s values (foregroundColor), as CSS rgb(); NULL for Wallet\u2019s default."
  },
  backgroundColor: {
    ...nullableText6,
    description: "The color of the pass (backgroundColor), as CSS rgb(); NULL for Wallet\u2019s default."
  },
  labelColor: {
    ...nullableText6,
    description: "The color of the pass\u2019s labels (labelColor), as CSS rgb(); NULL for Wallet\u2019s default."
  },
  semantics: {
    ...nullableText6,
    description: "The pass\u2019s semantic tags (semantics) as JSON, numbers as pass.json spells them: machine-readable facts such as a flight\u2019s airline, airports and departure, an event\u2019s start and venue, or a seat. NULL when the pass carries none."
  },
  userInfo: {
    ...nullableText6,
    description: "The issuer\u2019s own data for its app (userInfo) as JSON; NULL when the pass carries none."
  },
  personalization: {
    ...nullableText6,
    description: "The bundle\u2019s personalization.json as JSON: the details a reward card asks the holder for to sign up. NULL when the pass asks for none."
  },
  addedAt: {
    ...walletInstant,
    description: "When Wallet on this Mac stored the pass (pass.ingested_date), to the microsecond: when it was added here, or when iCloud brought it from another device."
  },
  updatedAt: {
    ...walletInstant,
    description: "When Wallet stored the version it holds (pass.modified_date), such as an update the issuer sent."
  },
  signedAt: {
    ...walletInstant,
    description: "When the issuer signed the version Wallet holds (pass.signing_date), to the second."
  },
  archivedAt: {
    ...walletInstant,
    description: "When Wallet archived the pass (pass_annotations.archived_timestamp); NULL for a pass it has not archived."
  },
  sortingState: {
    ...nullableInteger2,
    description: "passd\u2019s code for where Wallet sorts the pass (pass_annotations.sorting_state); passd\u2019s own predicates use it to split Wallet\u2019s current passes from its expired section. Apple does not document the codes: on macOS 27 it was 0 on passes without archivedAt and 1 on a pass archived as it was added. NULL for a pass with no annotation."
  },
  passJson: {
    ...text6,
    description: "The whole pass.json as JSON, numbers as the issuer spelled them, except authenticationToken, the credential the issuer\u2019s web service takes: the fields above under their own keys, and the ones this source does not name."
  }
};
var PassesStream = class extends AppleWalletStream {
  name = "passes";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per pass Wallet holds on this Mac: boarding passes, tickets, store and loyalty cards, coupons, as the issuer signed them, with when Wallet added, updated and archived each. Primary key id. A pass the user removes, on this Mac or on a device that syncs Wallet through iCloud, is deleted.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  records(pass) {
    return [
      {
        id: pass.id,
        passTypeIdentifier: pass.passTypeIdentifier,
        serialNumber: pass.serialNumber,
        teamIdentifier: pass.teamIdentifier,
        organizationName: pass.organizationName,
        description: pass.description,
        logoText: pass.logoText,
        style: pass.style,
        transitType: pass.transitType,
        formatVersion: pass.formatVersion,
        groupingIdentifier: pass.groupingIdentifier,
        relevantAt: pass.relevantDate?.at ?? null,
        relevantAtOffset: pass.relevantDate?.offsetMinutes ?? null,
        expiresAt: pass.expirationDate?.at ?? null,
        expiresAtOffset: pass.expirationDate?.offsetMinutes ?? null,
        voided: pass.voided,
        maxDistance: pass.maxDistance,
        associatedStoreIdentifiers: pass.associatedStoreIdentifiers,
        appLaunchUrl: pass.appLaunchUrl,
        webServiceUrl: pass.webServiceUrl,
        sharingProhibited: pass.sharingProhibited,
        foregroundColor: pass.foregroundColor,
        backgroundColor: pass.backgroundColor,
        labelColor: pass.labelColor,
        semantics: pass.semantics === null ? null : passJsonText(pass.semantics),
        userInfo: pass.userInfo === null ? null : passJsonText(pass.userInfo),
        personalization: pass.personalization === null ? null : passJsonText(pass.personalization),
        addedAt: pass.addedAt,
        updatedAt: pass.updatedAt,
        signedAt: pass.signedAt,
        archivedAt: pass.archivedAt,
        sortingState: pass.sortingState,
        passJson: passJsonText(pass.json)
      }
    ];
  }
};

// packages/sources/apple/wallet/dist/wallet-scan.js
var WalletScan = class {
  passes;
  constructor(passes) {
    this.passes = passes;
  }
  async [Symbol.asyncDispose]() {
  }
};

// packages/sources/apple/wallet/dist/apple-wallet-source.js
var readers = {
  passes: new PassesStream(),
  passFields: new PassFieldsStream(),
  passBarcodes: new PassBarcodesStream(),
  passLocations: new PassLocationsStream(),
  passBeacons: new PassBeaconsStream(),
  passRelevantDates: new PassRelevantDatesStream(),
  passLocalizations: new PassLocalizationsStream(),
  passImages: new PassImagesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var AppleWalletSource = class extends Source {
  identity;
  catalog = catalog;
  passes = readers.passes.describe();
  passFields = readers.passFields.describe();
  passBarcodes = readers.passBarcodes.describe();
  passLocations = readers.passLocations.describe();
  passBeacons = readers.passBeacons.describe();
  passRelevantDates = readers.passRelevantDates.describe();
  passLocalizations = readers.passLocalizations.describe();
  passImages = readers.passImages.describe();
  #store;
  constructor({ directory = walletStorePath } = {}) {
    super();
    this.#store = new WalletStore(directory);
    this.identity = `apple-wallet:${directory}`;
    Object.freeze(this);
  }
  async open() {
    return new WalletScan(await this.#store.passes());
  }
  failureType(error) {
    return error instanceof WalletUnavailableError ? "config" : "system";
  }
  coverage(_stream) {
    return localAppleStoreCoverage;
  }
  // passd commits to its database whenever a pass is added, updated,
  // archived or removed, and data_version cannot say which table a commit
  // touched, so each commit wakes every selected stream; the snapshot diff
  // writes nothing for the ones that did not change.
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const version = __using(_stack, this.#store.version());
      let seen = version.current;
      yield streams;
      try {
        for await (const _2 of setInterval(pollIntervalMs, void 0, {
          signal
        })) {
          const current = version.current;
          if (current === seen)
            continue;
          seen = current;
          yield streams;
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
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new TypeError(`Wallet has no stream ${stream.name}`);
    const records = reader.read(scan);
    const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
    for await (const message of messages) {
      if ("type" in message || configuration.fileReads.length === 0)
        yield message;
      else
        yield { ...message, file: reader.file(message.data) };
    }
  }
};

// packages/connectors/apple/wallet/dist/wallet-connector.js
var WalletConnector = class extends AppleConnector {
  // Wallet has no accounts or collections, and a pass's dates say when it is
  // relevant or expires, not which passes an import should keep.
  datedBy = null;
  // passd's store is not behind Full Disk Access.
  fullDiskAccess = false;
  choices = [];
  probe = "passes";
  unscoped = [];
  storeCopies = [];
  access() {
    return "No app needs to be open: macOS keeps the passes in Wallet on this Mac, with those iCloud brings from your iPhone.";
  }
  source() {
    return new AppleWalletSource();
  }
};
export {
  WalletConnector as default
};
