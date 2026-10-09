import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  decodeArchive,
  isBinaryPlist,
  plistJSON
} from "../../chunks/chunk-QPPOHR2G.mjs";
import {
  byId,
  name
} from "../../chunks/chunk-FGFSL4M6.mjs";
import {
  selected
} from "../../chunks/chunk-YM7ADF2O.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "../../chunks/chunk-SDFTRGL6.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-ZVP2EZLL.mjs";
import "../../chunks/chunk-BXQKRPES.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-G7SZ2AFI.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/contacts/dist/apple-contacts-source.js
import { mkdtempDisposable, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join4 } from "node:path";
import { setInterval } from "node:timers/promises";

// packages/sdks/apple/contacts/dist/address-book.js
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// packages/sdks/apple/contacts/dist/address-book-store.js
import { join as join2 } from "node:path";

// packages/sdks/apple/contacts/dist/contacts-tables.js
var kinds = [
  "text",
  "integer",
  "boolean",
  "number",
  "time",
  "data",
  "record",
  "calendarDate"
];
var isKind = (name2) => kinds.some((kind) => kind === name2);
function view(table, joins, list) {
  const attributes = {};
  for (const [kind, names = ""] of Object.entries(list)) {
    if (!isKind(kind))
      throw new TypeError(`Contacts has no attribute kind ${kind}`);
    for (const token of names.split(/\s+/).filter(Boolean)) {
      const [name2 = token, column = `Z${name2.toUpperCase()}`] = token.split(":");
      if (Object.hasOwn(attributes, name2))
        throw new TypeError(`Contacts ${table} lists ${name2} twice`);
      attributes[name2] = { column, kind };
    }
  }
  return { table, joins, attributes };
}
function labeledView(table, joins, own) {
  const shared = view(table, ["ZUNIQUEID", ...joins], {
    record: "owner",
    text: "label",
    boolean: "isPrimary isPrivate",
    integer: "orderingIndex iOSLegacyIdentifier"
  });
  const values2 = view(table, [], own);
  for (const name2 of Object.keys(values2.attributes))
    if (Object.hasOwn(shared.attributes, name2))
      throw new TypeError(`Contacts ${table} lists ${name2} twice`);
  return {
    ...shared,
    attributes: { ...shared.attributes, ...values2.attributes }
  };
}
var containerEntities = ["CNCDContainer"];
var groupEntities = [
  "ABCDGroup",
  "ABCDSubscribedGroup",
  "ABCDSmartGroup"
];
var contactEntities = [
  "ABCDContact",
  "ABCDSubscribedContact"
];
var recordView = view("ZABCDRECORD", ["Z_PK", "Z_ENT", "ZUNIQUEID"], {
  time: "creationDate modificationDate",
  integer: "displayFlags syncStatus iOSLegacyIdentifier",
  text: "externalCollectionPath externalFilename externalHash externalImageURI externalModificationTag externalURI externalUUID",
  data: "externalRepresentation"
});
var containerView = view("ZABCDRECORD", [], {
  text: "name:ZNAME1 externalIdentifier providerIdentifier remoteLocation serialNumber",
  integer: "type guardianFlags",
  boolean: "isAll",
  time: "lastSyncDate",
  record: "me"
});
var groupView = view("ZABCDRECORD", [], {
  record: "container",
  text: "name tmpRemoteLocation",
  integer: "externalGroupBehavior",
  data: "modifiedUniqueIdsData searchElementData"
});
var contactView = view("ZABCDRECORD", ["ZIMAGEDATA", "ZTHUMBNAILIMAGEDATA"], {
  record: "container:ZCONTAINER1 containerWhereContactIsMe",
  text: "title firstName middleName lastName suffix nickname maidenName phoneticFirstName phoneticMiddleName phoneticLastName phoneticOrganization phonemeData organization department jobTitle linkId identityUniqueId preferredApplePersonaIdentifier preferredLikenessSource imageType imageReference cropRect cropRectID wallpaperURI downtimeWhitelist tmpHomePage",
  integer: "privacyFlags",
  boolean: "preferredForLinkName preferredForLinkPhoto",
  time: "imageSyncFailedTime wallpaperSyncFailedTime",
  data: "imageHash cropRectHash avatarRecipeData memojiMetadata sensitiveContentConfiguration wallpaper",
  calendarDate: "birthday"
});
var noteView = view("ZABCDNOTE", ["ZCONTACT"], {
  text: "text",
  data: "richTextData"
});
var dateComponentsView = view("ZABCDDATECOMPONENTS", ["ZCONTACT"], {
  text: "uniqueId calendarIdentifier",
  integer: "era year month day iOSLegacyIdentifier",
  boolean: "isLeapMonth"
});
var phoneNumberView = labeledView("ZABCDPHONENUMBER", ["Z_PK"], {
  text: "fullNumber countryCode areaCode localNumber extension"
});
var emailAddressView = labeledView("ZABCDEMAILADDRESS", ["Z_PK"], {
  text: "address"
});
var postalAddressView = labeledView("ZABCDPOSTALADDRESS", ["Z_PK"], {
  text: "street subLocality city state region zipCode countryName countryCode sama",
  data: "customValuesDictionary"
});
var urlAddressView = labeledView("ZABCDURLADDRESS", [], {
  text: "url"
});
var socialProfileView = labeledView("ZABCDSOCIALPROFILE", [], {
  text: "serviceName username userIdentifier urlString displayname bundleIdentifiersString teamIdentifier",
  data: "customValuesData"
});
var messagingAddressView = labeledView("ZABCDMESSAGINGADDRESS", ["ZSERVICE"], { text: "address userIdentifier bundleIdentifiersString teamIdentifier" });
var relatedNameView = labeledView("ZABCDRELATEDNAME", [], {
  text: "name"
});
var contactDateView = labeledView("ZABCDCONTACTDATE", [], {
  calendarDate: "date"
});
var calendarUriView = labeledView("ZABCDCALENDARURI", [], {
  text: "url"
});
var addressingGrammarView = labeledView("ZABCDADDRESSINGGRAMMAR", [], {
  text: "addressingGrammar"
});
var likenessView = labeledView("ZABCDLIKENESS", [], {
  integer: "kind",
  text: "version",
  data: "data"
});
var alertToneView = view("ZABCDALERTTONE", ["ZUNIQUEID"], {
  record: "owner",
  text: "type toneData",
  integer: "iOSLegacyIdentifier"
});
var customPropertyView = view("ZABCDCUSTOMPROPERTY", ["Z_PK"], {
  text: "propertyName recordType",
  integer: "valueType"
});
var customPropertyValueView = view("ZABCDCUSTOMPROPERTYVALUE", ["ZUNIQUEID", "ZCUSTOMPROPERTY"], {
  record: "owner",
  text: "label stringValue",
  boolean: "isPrimary isPrivate",
  integer: "orderingIndex iOSLegacyIdentifier dateValueYear",
  number: "numberValue",
  time: "dateValue",
  data: "dataValue"
});
var remoteLocationView = view("ZABCDREMOTELOCATION", ["ZUNIQUEID"], {
  record: "owner",
  text: "label url",
  boolean: "isPrimary isPrivate",
  integer: "orderingIndex"
});
var views = [
  recordView,
  containerView,
  groupView,
  contactView,
  noteView,
  dateComponentsView,
  phoneNumberView,
  emailAddressView,
  postalAddressView,
  urlAddressView,
  socialProfileView,
  messagingAddressView,
  relatedNameView,
  contactDateView,
  calendarUriView,
  addressingGrammarView,
  likenessView,
  alertToneView,
  customPropertyView,
  customPropertyValueView,
  remoteLocationView
];
var otherColumns = {
  Z_PRIMARYKEY: ["Z_ENT", "Z_NAME"],
  Z_22PARENTGROUPS: ["Z_22CONTACTS", "Z_19PARENTGROUPS1"],
  Z_18PARENTGROUPS: ["Z_18CHILDGROUPS", "Z_19PARENTGROUPS"],
  ZABCDSERVICE: ["Z_PK", "ZSERVICENAME"],
  ZABCDUNKNOWNPROPERTY: ["ZOWNER", "ZPROPERTYNAME", "ZORIGINALLINE"],
  ZABCDDISTRIBUTIONLISTCONFIG: [
    "ZGROUP",
    "ZCONTACT",
    "ZEMAIL",
    "ZPHONE",
    "ZADDRESS",
    "ZPROPERTYNAME"
  ]
};
var requiredColumns = (() => {
  const required = /* @__PURE__ */ new Map();
  const add = (table, columns) => {
    const present = required.get(table) ?? /* @__PURE__ */ new Set();
    required.set(table, present);
    for (const column of columns)
      present.add(column);
  };
  for (const { table, joins, attributes } of views)
    add(table, [
      ...joins,
      ...Object.values(attributes).map(({ column }) => column)
    ]);
  for (const [table, columns] of Object.entries(otherColumns))
    add(table, columns);
  return Object.fromEntries([...required].map(([table, columns]) => [table, [...columns]]));
})();
var requiredEntities = [
  ...contactEntities,
  ...groupEntities,
  ...containerEntities
];

// packages/sdks/apple/contacts/dist/contacts-values.js
import { join } from "node:path";
var ContactsData = class {
  bytes;
  constructor(bytes) {
    this.bytes = bytes;
  }
  get archived() {
    return isBinaryPlist(this.bytes);
  }
  archive() {
    return decodeArchive(this.bytes);
  }
};
function attributeValue(kind, stored) {
  if (stored === void 0 || stored === null)
    return null;
  if (kind === "boolean")
    return stored !== 0;
  if (stored instanceof Uint8Array)
    return new ContactsData(stored);
  if (kind === "time")
    return new Date(String(stored));
  return typeof stored === "bigint" ? Number(stored) : stored;
}
function storedData(path, directory, value) {
  if (value[0] === 1)
    return { storage: "inline", bytes: value.subarray(1) };
  if (value[0] === 2) {
    const end = value.indexOf(0, 1);
    const id3 = Buffer.from(value.subarray(1, end === -1 ? value.length : end)).toString("ascii");
    return {
      storage: "external",
      id: id3,
      path: join(directory, ".AddressBook-v22_SUPPORT/_EXTERNAL_DATA", id3)
    };
  }
  throw new TypeError(`Contacts store ${path} holds data in an unknown encoding (first byte ${value[0]})`);
}

// packages/sdks/apple/contacts/dist/errors.js
var ContactsUnavailableError = class extends Error {
  name = "ContactsUnavailableError";
  constructor(path, cause) {
    super(`The Contacts store at ${path} cannot be read. Allow the process that runs the export Contacts access or Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Contacts.app does not need to be open.`, { cause });
  }
};
var ContactsSchemaError = class extends Error {
  name = "ContactsSchemaError";
  constructor(path, missing) {
    super(`The Contacts store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/contacts/dist/address-book-store.js
var storeFile = "AddressBook-v22.abcddb";
var appleEpoch = 978307200;
var instant = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} + ${appleEpoch}, 'unixepoch')`;
var datePart = (column, format) => `CAST(strftime('${format}', ${column} + ${appleEpoch}, 'unixepoch') AS INTEGER)`;
var select = ({ attributes }, alias) => Object.entries(attributes).flatMap(([name2, { column, kind }]) => {
  const value = `${alias}.${column}`;
  if (kind === "time")
    return [`${instant(value)} AS "${name2}"`];
  if (kind === "record")
    return [
      `(SELECT o.ZUNIQUEID FROM ZABCDRECORD o WHERE o.Z_PK = ${value}) AS "${name2}"`
    ];
  if (kind === "calendarDate")
    return [
      `CASE WHEN ${datePart(value, "%Y")} = 1604 THEN NULL ELSE ${datePart(value, "%Y")} END AS "${name2}@year"`,
      `${datePart(value, "%m")} AS "${name2}@month"`,
      `${datePart(value, "%d")} AS "${name2}@day"`
    ];
  return [`${value} AS "${name2}"`];
}).join(", ");
var part = (stored) => typeof stored === "number" ? stored : null;
var text = (stored) => typeof stored === "string" ? stored : null;
var values = ({ attributes }, row) => Object.fromEntries(Object.entries(attributes).map(([name2, { kind }]) => [
  name2,
  kind === "calendarDate" ? {
    year: part(row[`${name2}@year`]),
    month: part(row[`${name2}@month`]),
    day: part(row[`${name2}@day`])
  } : attributeValue(kind, row[name2])
]));
var entityJoin = (alias, entities) => `JOIN Z_PRIMARYKEY ${alias}_entity ON ${alias}_entity.Z_ENT = ${alias}.Z_ENT AND ${alias}_entity.Z_NAME IN (${entities.map((name2) => `'${name2}'`).join(", ")})`;
var entityOf = (entities, stored) => entities.find((entity) => entity === stored) ?? null;
var AddressBookStore = class {
  // The Sources directory name, or null for the On My Mac store.
  source;
  directory;
  path;
  #database;
  constructor(source, directory) {
    this.source = source;
    this.directory = directory;
    this.path = join2(directory, storeFile);
    this.#database = new AppDatabase(this.path, ContactsUnavailableError);
  }
  // Refuses a store without a column or entity a reader needs, and closes
  // it: a renamed entity would match no rows, and an account read as empty
  // loses its contacts from every target.
  requireLayout() {
    this.#database.requireColumns(requiredColumns, ContactsSchemaError);
    const entities = new Set(this.#database.all("SELECT Z_NAME FROM Z_PRIMARYKEY").map((entity) => entity.Z_NAME));
    const missing = requiredEntities.filter((entity) => !entities.has(entity)).map((entity) => `entity ${entity}`);
    if (missing.length === 0)
      return;
    this[Symbol.dispose]();
    throw new ContactsSchemaError(this.path, missing);
  }
  containers() {
    return this.#records("r", containerView, containerEntities);
  }
  groups() {
    return this.#records("g", groupView, groupEntities);
  }
  contacts() {
    return this.#records("c", contactView, contactEntities);
  }
  groupMembers() {
    return this.#database.all('SELECT g.ZUNIQUEID AS "@groupId", c.ZUNIQUEID AS "@contactId" FROM Z_22PARENTGROUPS j JOIN ZABCDRECORD g ON g.Z_PK = j.Z_19PARENTGROUPS1 JOIN ZABCDRECORD c ON c.Z_PK = j.Z_22CONTACTS').map((row) => ({
      groupId: text(row["@groupId"]),
      contactId: text(row["@contactId"])
    }));
  }
  groupSubgroups() {
    return this.#database.all('SELECT p.ZUNIQUEID AS "@parentGroupId", g.ZUNIQUEID AS "@childGroupId" FROM Z_18PARENTGROUPS j JOIN ZABCDRECORD p ON p.Z_PK = j.Z_19PARENTGROUPS JOIN ZABCDRECORD g ON g.Z_PK = j.Z_18CHILDGROUPS').map((row) => ({
      parentGroupId: text(row["@parentGroupId"]),
      childGroupId: text(row["@childGroupId"])
    }));
  }
  notes() {
    return this.#contactParts("n", noteView);
  }
  alternateBirthdays() {
    return this.#contactParts("d", dateComponentsView);
  }
  phoneNumbers() {
    return this.#valueRows("p", phoneNumberView);
  }
  emailAddresses() {
    return this.#valueRows("e", emailAddressView);
  }
  postalAddresses() {
    return this.#valueRows("a", postalAddressView);
  }
  urlAddresses() {
    return this.#valueRows("u", urlAddressView);
  }
  socialProfiles() {
    return this.#valueRows("s", socialProfileView);
  }
  messagingAddresses() {
    return this.#database.all(`SELECT m.ZUNIQUEID AS "@id", ${select(messagingAddressView, "m")}, (SELECT s.ZSERVICENAME FROM ZABCDSERVICE s WHERE s.Z_PK = m.ZSERVICE) AS "@service" FROM ZABCDMESSAGINGADDRESS m`).map((row) => ({
      id: text(row["@id"]),
      values: values(messagingAddressView, row),
      service: text(row["@service"])
    }));
  }
  relatedNames() {
    return this.#valueRows("n", relatedNameView);
  }
  contactDates() {
    return this.#valueRows("d", contactDateView);
  }
  calendarUris() {
    return this.#valueRows("u", calendarUriView);
  }
  addressingGrammars() {
    return this.#valueRows("g", addressingGrammarView);
  }
  likenesses() {
    return this.#valueRows("l", likenessView);
  }
  alertTones() {
    return this.#valueRows("t", alertToneView);
  }
  // Each value with its property's definition, NULL when it has none.
  customPropertyValues() {
    return this.#database.all(`SELECT v.ZUNIQUEID AS "@id", ${select(customPropertyView, "p")}, ${select(customPropertyValueView, "v")} FROM ZABCDCUSTOMPROPERTYVALUE v LEFT JOIN ZABCDCUSTOMPROPERTY p ON p.Z_PK = v.ZCUSTOMPROPERTY`).map((row) => ({
      id: text(row["@id"]),
      values: {
        ...values(customPropertyView, row),
        ...values(customPropertyValueView, row)
      }
    }));
  }
  remoteLocations() {
    return this.#valueRows("l", remoteLocationView);
  }
  // The native rows have no identifier, and the same line stored twice on
  // one record is one fact.
  unknownProperties() {
    return this.#database.all('SELECT DISTINCT r.ZUNIQUEID AS "@recordId", u.ZPROPERTYNAME AS "@propertyName", u.ZORIGINALLINE AS "@originalLine" FROM ZABCDUNKNOWNPROPERTY u JOIN ZABCDRECORD r ON r.Z_PK = u.ZOWNER').map((row) => ({
      recordId: text(row["@recordId"]),
      propertyName: attributeValue("text", row["@propertyName"]),
      originalLine: attributeValue("text", row["@originalLine"])
    }));
  }
  distributionListConfigs() {
    return this.#database.all('SELECT g.ZUNIQUEID AS "@groupId", c.ZUNIQUEID AS "@contactId", d.ZPROPERTYNAME AS "@propertyName", (SELECT x.ZUNIQUEID FROM ZABCDEMAILADDRESS x WHERE x.Z_PK = d.ZEMAIL) AS "@emailId", (SELECT x.ZUNIQUEID FROM ZABCDPHONENUMBER x WHERE x.Z_PK = d.ZPHONE) AS "@phoneId", (SELECT x.ZUNIQUEID FROM ZABCDPOSTALADDRESS x WHERE x.Z_PK = d.ZADDRESS) AS "@addressId" FROM ZABCDDISTRIBUTIONLISTCONFIG d JOIN ZABCDRECORD g ON g.Z_PK = d.ZGROUP JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT').map((row) => ({
      groupId: text(row["@groupId"]),
      contactId: text(row["@contactId"]),
      propertyName: attributeValue("text", row["@propertyName"]),
      emailId: text(row["@emailId"]),
      phoneId: text(row["@phoneId"]),
      addressId: text(row["@addressId"])
    }));
  }
  images() {
    return this.#database.all(`SELECT c.ZUNIQUEID AS "@contactId", c.ZIMAGEDATA AS "@image", c.ZTHUMBNAILIMAGEDATA AS "@thumbnail" FROM ZABCDRECORD c ${entityJoin("c", contactEntities)} WHERE c.ZIMAGEDATA IS NOT NULL OR c.ZTHUMBNAILIMAGEDATA IS NOT NULL`).map((row) => {
      const decode = (stored) => stored instanceof Uint8Array ? storedData(this.path, this.directory, stored) : null;
      return {
        contactId: text(row["@contactId"]),
        image: () => decode(row["@image"]),
        thumbnail: () => decode(row["@thumbnail"])
      };
    });
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  #records(alias, view2, entities) {
    return this.#database.all(`SELECT ${alias}.ZUNIQUEID AS "@id", ${alias}_entity.Z_NAME AS "@entity", ${select(view2, alias)}, ${select(recordView, alias)} FROM ZABCDRECORD ${alias} ${entityJoin(alias, entities)}`).map((row) => ({
      id: text(row["@id"]),
      entity: entityOf(entities, row["@entity"]),
      values: { ...values(view2, row), ...values(recordView, row) }
    }));
  }
  #contactParts(alias, view2) {
    return this.#database.all(`SELECT c.ZUNIQUEID AS "@contactId", ${select(view2, alias)} FROM ${view2.table} ${alias} JOIN ZABCDRECORD c ON c.Z_PK = ${alias}.ZCONTACT`).map((row) => ({
      contactId: text(row["@contactId"]),
      values: values(view2, row)
    }));
  }
  #valueRows(alias, view2) {
    return this.#database.all(`SELECT ${alias}.ZUNIQUEID AS "@id", ${select(view2, alias)} FROM ${view2.table} ${alias}`).map((row) => ({ id: text(row["@id"]), values: values(view2, row) }));
  }
};

// packages/sdks/apple/contacts/dist/address-book.js
var addressBookDirectory = join3(homedir(), "Library/Application Support/AddressBook");
function storeDirectories(directory) {
  const sources = join3(directory, "Sources");
  let entries;
  try {
    entries = readdirSync(sources, { withFileTypes: true });
  } catch (cause) {
    throw new ContactsUnavailableError(sources, cause);
  }
  return [
    { source: null, directory },
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().map((source) => ({ source, directory: join3(sources, source) }))
  ];
}
var AddressBook = class _AddressBook {
  stores;
  constructor(stores) {
    this.stores = stores;
  }
  static async open(directory) {
    const stores = [];
    try {
      for (const found of storeDirectories(directory)) {
        const store = new AddressBookStore(found.source, found.directory);
        stores.push(store);
        store.requireLayout();
      }
      return new _AddressBook(stores);
    } catch (cause) {
      for (const store of stores)
        store[Symbol.dispose]();
      throw cause;
    }
  }
  async [Symbol.asyncDispose]() {
    for (const store of this.stores)
      store[Symbol.dispose]();
  }
};
var AddressBookVersion = class {
  #stores = /* @__PURE__ */ new Map();
  directory;
  constructor(directory) {
    this.directory = directory;
  }
  get current() {
    const paths = storeDirectories(this.directory).map(({ directory }) => join3(directory, storeFile));
    for (const [path, version] of this.#stores)
      if (!paths.includes(path)) {
        version[Symbol.dispose]();
        this.#stores.delete(path);
      }
    return JSON.stringify(paths.map((path) => {
      let version = this.#stores.get(path);
      if (version === void 0) {
        version = new AppDatabaseVersion(path, ContactsUnavailableError);
        this.#stores.set(path, version);
      }
      return [path, version.current];
    }));
  }
  [Symbol.dispose]() {
    for (const version of this.#stores.values())
      version[Symbol.dispose]();
    this.#stores.clear();
  }
};
var ContactsStore = class {
  #directory;
  constructor(directory) {
    this.#directory = directory;
  }
  open() {
    return AddressBook.open(this.#directory);
  }
  version() {
    return new AddressBookVersion(this.#directory);
  }
};

// packages/sources/apple/contacts/dist/contacts-scan.js
var ContactSelection = class {
  #containers;
  #contacts;
  #groups;
  constructor(store, collectionIds) {
    this.#containers = new Set(store.containers().filter((container) => selected(collectionIds, container.id)).map((container) => container.id));
    this.#contacts = new Set(store.contacts().filter((contact) => this.#has(this.#containers, contact.values.container)).map((contact) => contact.id));
    this.#groups = new Set(store.groups().filter((group) => this.#has(this.#containers, group.values.container)).map((group) => group.id));
  }
  container(id3) {
    return this.#has(this.#containers, id3);
  }
  contact(id3) {
    return this.#has(this.#contacts, id3);
  }
  group(id3) {
    return this.#has(this.#groups, id3);
  }
  record(id3) {
    return this.container(id3) || this.contact(id3) || this.group(id3);
  }
  #has(ids, id3) {
    return (typeof id3 === "string" || id3 === null) && ids.has(id3);
  }
};
var imageKey = (contactId, kind) => JSON.stringify([contactId, kind]);
var ContactsScan = class {
  images = /* @__PURE__ */ new Map();
  #book;
  #scope;
  #selections = /* @__PURE__ */ new Map();
  constructor(book, scope) {
    this.#book = book;
    this.#scope = scope;
  }
  get stores() {
    return this.#book.stores;
  }
  // null when the import takes every container.
  selection(store) {
    const { collectionIds } = this.#scope;
    if (collectionIds === void 0)
      return null;
    let selection = this.#selections.get(store);
    if (selection === void 0) {
      selection = new ContactSelection(store, collectionIds);
      this.#selections.set(store, selection);
    }
    return selection;
  }
  async [Symbol.asyncDispose]() {
    await this.#book[Symbol.asyncDispose]();
  }
};

// packages/sources/apple/contacts/dist/contacts-fields.js
var { text: text2, nullableText, nullableTimestamp } = eventKitFields;
var nullableInteger = { type: ["integer", "null"] };
var nullableNumber = { type: ["number", "null"] };
var nullableBoolean = { type: ["boolean", "null"] };
var schemas = {
  text: nullableText,
  integer: nullableInteger,
  boolean: nullableBoolean,
  number: nullableNumber,
  time: nullableTimestamp,
  data: nullableText,
  record: nullableText
};
var conversions = {
  text: "as stored",
  integer: "as stored",
  number: "as stored",
  boolean: "with 0 read as false and any other stored value as true",
  time: "Core Data seconds since 2001-01-01 converted to a UTC instant with millisecond precision",
  data: "a binary property list as JSON (keyed archives unarchived, nested bytes as Base64), other bytes as Base64",
  record: "a ZABCDRECORD reference resolved to that record's ZUNIQUEID"
};
var unverified = "Meaning not verified: Apple does not document this store.";
var localStores = "Read from this Mac's Contacts stores, On My Mac and one per account under AddressBook/Sources, so it holds what has synced to this Mac rather than a complete cloud account; a configured container selection limits it further. Relationships name source streams, not destination tables, and identifiers name native records, not people merged across stores.";
function provenance(kind, table, column) {
  const absent = kind === "record" ? "NULL when unset or no record matches" : "NULL when the store holds no value";
  return `AddressBook ${table}.${column}, ${conversions[kind]}; ${absent}. ${unverified}`;
}
function checked(view2, naming8) {
  const unknown = [
    ...Object.keys(naming8.renames ?? {}),
    ...Object.keys(naming8.dates ?? {})
  ].filter((name2) => !Object.hasOwn(view2.attributes, name2));
  if (unknown.length > 0)
    throw new TypeError(`Contacts ${view2.table} has no attributes ${unknown.join(", ")}`);
  return naming8;
}
function dateNames(naming8, name2) {
  const names = naming8.dates?.[name2];
  if (names === void 0)
    throw new TypeError(`Contacts names no fields for date ${name2}`);
  return names;
}
function attributeFields(view2, naming8 = {}) {
  checked(view2, naming8);
  const fields = {};
  for (const [name2, { column, kind }] of Object.entries(view2.attributes)) {
    if (kind !== "calendarDate") {
      fields[naming8.renames?.[name2] ?? name2] = {
        ...schemas[kind],
        description: provenance(kind, view2.table, column)
      };
      continue;
    }
    const [year, month, day] = dateNames(naming8, name2);
    const read = `of the date in AddressBook ${view2.table}.${column}, Core Data seconds since 2001-01-01 read as a Gregorian UTC date`;
    fields[year] = {
      ...nullableInteger,
      description: `Year ${read}; NULL when no date is stored or its year is 1604, the year Contacts stores for a date without a year.`
    };
    fields[month] = {
      ...nullableInteger,
      description: `Month (1-12) ${read}; NULL when no date is stored.`
    };
    fields[day] = {
      ...nullableInteger,
      description: `Day of the month ${read}; NULL when no date is stored.`
    };
  }
  return fields;
}
function explained(fields, meanings) {
  const described = { ...fields };
  for (const [name2, description] of Object.entries(meanings)) {
    const field = fields[name2];
    if (field === void 0)
      throw new TypeError(`Contacts has no field ${name2} to describe`);
    described[name2] = { ...field, description };
  }
  return described;
}
function entityKind(kinds4) {
  const meanings = Object.entries(kinds4).map(([entity, kind]) => `${kind} for ${entity}`).join(", ");
  return {
    ...text2,
    enum: Object.values(kinds4),
    description: `Core Data entity of this record, from Z_PRIMARYKEY.Z_NAME: ${meanings}. Apple does not document how these entities differ.`
  };
}
var isCalendarDate = (value) => value !== null && typeof value === "object" && !(value instanceof Date) && !(value instanceof ContactsData);
function encode(value) {
  if (value instanceof Date)
    return value.toISOString();
  if (value instanceof ContactsData)
    return value.archived ? plistJSON(value.archive()) : Buffer.from(value.bytes).toString("base64");
  return value;
}
function attributeRecord(view2, values2, naming8 = {}) {
  const record = {};
  for (const [name2, { kind }] of Object.entries(view2.attributes)) {
    const value = values2[name2] ?? null;
    if (kind !== "calendarDate") {
      record[naming8.renames?.[name2] ?? name2] = encode(value);
      continue;
    }
    const [year, month, day] = dateNames(naming8, name2);
    const date = isCalendarDate(value) ? value : null;
    record[year] = date?.year ?? null;
    record[month] = date?.month ?? null;
    record[day] = date?.day ?? null;
  }
  return record;
}

// packages/sources/apple/contacts/dist/apple-contacts-stream.js
var AppleContactsStream = class {
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
  // One row at a time, so an image's bytes are hashed one file after another.
  async read(scan) {
    const fields = Object.keys(this.jsonSchema.properties);
    const records = [];
    for (const store of scan.stores) {
      const selection = scan.selection(store);
      for (const row of this.rows(store)) {
        if (selection !== null && !this.accepts(row, selection))
          continue;
        for (const values2 of await this.records(row, store, scan))
          records.push(Object.fromEntries(fields.map((field) => [field, values2[field] ?? null])));
      }
    }
    return validateRecords(this, records, "Contacts");
  }
};

// packages/sources/apple/contacts/dist/labeled-value-stream.js
var labeledValue = "Primary key id; contactId refers to contacts.id, and a contact can have several. label is the stored, unlocalized label. isPrimary, isPrivate and orderingIndex pass through as stored; whether orderingIndex orders a contact's values densely or uniquely is not verified.";
var labeled = (naming8) => ({
  ...naming8,
  renames: { owner: "contactId" }
});
function labeledFields(view2, naming8 = {}) {
  return explained({ id: eventKitFields.id, ...attributeFields(view2, labeled(naming8)) }, {
    id: `Identifier of this labeled value, AddressBook ${view2.table}.ZUNIQUEID; the primary key.`,
    contactId: `Owning contact: ${view2.table}.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source; a contact can have many of these values. NULL when unset or no record matches.`,
    label: `Label from AddressBook ${view2.table}.ZLABEL, as stored and not localized: a built-in label is a token such as _$!<Mobile>!$_, a custom label is its own text. NULL when the store holds no value; it can also be empty text.`
  });
}
var LabeledValueStream = class extends AppleContactsStream {
  primaryKey = ["id"];
  naming = {};
  accepts(row, selection) {
    return selection.contact(row.values.owner);
  }
  records(row) {
    return [
      {
        id: row.id,
        ...attributeRecord(this.view, row.values, labeled(this.naming))
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/addressing-grammars-stream.js
var properties = labeledFields(addressingGrammarView);
var AddressingGrammarsStream = class extends LabeledValueStream {
  name = "addressingGrammars";
  jsonSchema = {
    type: "object",
    description: `One row per addressing grammar value of a contact, a labeled value in the AddressBook table ZABCDADDRESSINGGRAMMAR; the value is exported as stored and its format is not documented by Apple. ${labeledValue} ${localStores}`,
    properties,
    required: Object.keys(properties)
  };
  view = addressingGrammarView;
  rows(store) {
    return store.addressingGrammars();
  }
};

// packages/sources/apple/contacts/dist/streams/alert-tones-stream.js
var naming = { renames: { owner: "contactId" } };
var properties2 = explained({
  id: eventKitFields.id,
  ...attributeFields(alertToneView, naming)
}, {
  id: "Alert tone identifier, AddressBook ZABCDALERTTONE.ZUNIQUEID; the primary key.",
  contactId: "Owning contact: ZABCDALERTTONE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches."
});
var AlertTonesStream = class extends AppleContactsStream {
  name = "alertTones";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: `One row per alert tone record of a contact in the AddressBook table ZABCDALERTTONE. Primary key id; contactId refers to contacts.id, and a contact can have several. type and toneData are exported as stored and their values are not documented by Apple. ${localStores}`,
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(store) {
    return store.alertTones();
  }
  accepts(row, selection) {
    return selection.contact(row.values.owner);
  }
  records(row) {
    return [
      {
        id: row.id,
        ...attributeRecord(alertToneView, row.values, naming)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/alternate-birthdays-stream.js
var properties3 = explained({ contactId: eventKitFields.id, ...attributeFields(dateComponentsView) }, {
  contactId: "Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDATECOMPONENTS.ZCONTACT); the primary key. Refers to contacts.id within this source.",
  uniqueId: "Native identifier of this date-components record, AddressBook ZABCDDATECOMPONENTS.ZUNIQUEID, as stored; no other stream refers to it.",
  calendarIdentifier: "Calendar identifier as stored in AddressBook ZABCDDATECOMPONENTS.ZCALENDARIDENTIFIER; names the calendar that era, year, month and day are counted in.",
  era: "Era component as stored in AddressBook ZABCDDATECOMPONENTS.ZERA, in the calendar named by calendarIdentifier; NULL when the store holds no value.",
  year: "Year component as stored in AddressBook ZABCDDATECOMPONENTS.ZYEAR, in the calendar named by calendarIdentifier and not converted; not comparable with contacts.birthdayYear. NULL when the store holds no value.",
  month: "Month component as stored in AddressBook ZABCDDATECOMPONENTS.ZMONTH, in the calendar named by calendarIdentifier; NULL when the store holds no value.",
  day: "Day component as stored in AddressBook ZABCDDATECOMPONENTS.ZDAY, in the calendar named by calendarIdentifier; NULL when the store holds no value."
});
var AlternateBirthdaysStream = class extends AppleContactsStream {
  name = "alternateBirthdays";
  primaryKey = ["contactId"];
  jsonSchema = {
    type: "object",
    description: `One row per contact with a non-Gregorian birthday (CNContact.nonGregorianBirthday, which a live store saves here), as date components in the AddressBook table ZABCDDATECOMPONENTS. Primary key contactId, which refers to contacts.id; one record per contact is assumed, since the store does not enforce it. Components stay in the calendar named by calendarIdentifier and are not converted, so they do not compare with the contact's Gregorian birthdayYear, birthdayMonth and birthdayDay. ${localStores}`,
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(store) {
    return store.alternateBirthdays();
  }
  accepts(row, selection) {
    return selection.contact(row.contactId);
  }
  records(row) {
    return [
      {
        contactId: row.contactId,
        ...attributeRecord(dateComponentsView, row.values)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/calendar-uris-stream.js
var properties4 = labeledFields(calendarUriView);
var CalendarUrisStream = class extends LabeledValueStream {
  name = "calendarUris";
  jsonSchema = {
    type: "object",
    description: `One row per calendar URI of a contact, a labeled value in the AddressBook table ZABCDCALENDARURI. ${labeledValue} ${localStores}`,
    properties: properties4,
    required: Object.keys(properties4)
  };
  view = calendarUriView;
  rows(store) {
    return store.calendarUris();
  }
};

// packages/sources/apple/contacts/dist/streams/contact-dates-stream.js
var naming2 = { dates: { date: ["year", "month", "day"] } };
var properties5 = labeledFields(contactDateView, naming2);
var ContactDatesStream = class extends LabeledValueStream {
  name = "contactDates";
  jsonSchema = {
    type: "object",
    description: `One row per labeled date of a contact in the AddressBook table ZABCDCONTACTDATE, split into Gregorian year, month and day; year is NULL for a date stored without a year. ${labeledValue} ${localStores}`,
    properties: properties5,
    required: Object.keys(properties5)
  };
  view = contactDateView;
  naming = naming2;
  rows(store) {
    return store.contactDates();
  }
};

// packages/sources/apple/contacts/dist/streams/contacts-stream.js
var kinds2 = {
  ABCDContact: "contact",
  ABCDSubscribedContact: "subscribedContact"
};
var naming3 = {
  renames: {
    container: "containerId",
    containerWhereContactIsMe: "meOfContainerId"
  },
  dates: { birthday: ["birthdayYear", "birthdayMonth", "birthdayDay"] }
};
var properties6 = explained({
  id: eventKitFields.id,
  kind: entityKind(kinds2),
  ...attributeFields(contactView, naming3),
  ...attributeFields(recordView)
}, {
  id: "Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. contactId fields in other streams of this source refer to it.",
  containerId: "Owning container: AddressBook ZABCDRECORD.ZCONTAINER1 resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
  meOfContainerId: "AddressBook ZABCDRECORD.ZCONTAINERWHERECONTACTISME resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches."
});
var ContactsStream = class extends AppleContactsStream {
  name = "contacts";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: `One row per contact record: an ABCDContact or ABCDSubscribedContact, told apart by kind. Primary key id; containerId refers to containers.id. Multi-valued details are separate streams keyed by their own id with contactId: phoneNumbers, emailAddresses, postalAddresses, urlAddresses, socialProfiles, messagingAddresses, relatedNames, contactDates, calendarUris, addressingGrammars and likenesses; alertTones, notes, alternateBirthdays and images also carry contactId, and groupMembers lists stored group membership. The same person in two stores is two rows; this source does not merge them. ${localStores}`,
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(store) {
    return store.contacts();
  }
  accepts(row, selection) {
    return selection.contact(row.id);
  }
  records(row) {
    return [
      {
        id: row.id,
        kind: row.entity === null ? null : kinds2[row.entity],
        ...attributeRecord(contactView, row.values, naming3),
        ...attributeRecord(recordView, row.values)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/containers-stream.js
var naming4 = { renames: { me: "meContactId" } };
var properties7 = explained({
  id: eventKitFields.id,
  source: eventKitFields.nullableText,
  ...attributeFields(containerView, naming4),
  ...attributeFields(recordView)
}, {
  id: "Container identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key.",
  source: "Directory name under AddressBook/Sources of the account store this container was read from; NULL for the On My Mac store at the AddressBook root.",
  meContactId: "AddressBook ZABCDRECORD.ZME resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches."
});
var ContainersStream = class extends AppleContactsStream {
  name = "containers";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: `One row per Contacts container, a CNCDContainer record in a store. Primary key id. contacts.containerId, contacts.meOfContainerId and groups.containerId refer to id. ${localStores}`,
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(store) {
    return store.containers();
  }
  accepts(row, selection) {
    return selection.container(row.id);
  }
  records(row, store) {
    return [
      {
        id: row.id,
        source: store.source,
        ...attributeRecord(containerView, row.values, naming4),
        ...attributeRecord(recordView, row.values)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/custom-property-values-stream.js
var naming5 = { renames: { owner: "recordId" } };
var properties8 = explained({
  id: eventKitFields.id,
  ...attributeFields(customPropertyView),
  ...attributeFields(customPropertyValueView, naming5)
}, {
  id: "Custom property value identifier, AddressBook ZABCDCUSTOMPROPERTYVALUE.ZUNIQUEID; the primary key.",
  propertyName: `Property name as stored in AddressBook ZABCDCUSTOMPROPERTY.ZPROPERTYNAME, the definition ZABCDCUSTOMPROPERTYVALUE.ZCUSTOMPROPERTY references; NULL when the store holds no value or no definition record matches. ${unverified}`,
  recordType: `AddressBook ZABCDCUSTOMPROPERTY.ZRECORDTYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
  valueType: `AddressBook ZABCDCUSTOMPROPERTY.ZVALUETYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
  recordId: "Owning record: ZABCDCUSTOMPROPERTYVALUE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches."
});
var CustomPropertyValuesStream = class extends AppleContactsStream {
  name = "customPropertyValues";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: `One row per custom property value in the AddressBook table ZABCDCUSTOMPROPERTYVALUE, on any record, with its property definition from ZABCDCUSTOMPROPERTY. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. propertyName, recordType and valueType are NULL when the value has no definition record. Which of stringValue, numberValue, dateValue and dataValue holds the value is not verified against valueType. ${localStores}`,
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(store) {
    return store.customPropertyValues();
  }
  accepts(row, selection) {
    return selection.record(row.values.owner);
  }
  records(row) {
    return [
      {
        id: row.id,
        ...attributeRecord(customPropertyView, row.values),
        ...attributeRecord(customPropertyValueView, row.values, naming5)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/distribution-list-configs-stream.js
var { id, text: text3, nullableText: nullableText2 } = eventKitFields;
var properties9 = explained({
  groupId: id,
  contactId: id,
  propertyName: text3,
  emailId: nullableText2,
  phoneId: nullableText2,
  addressId: nullableText2
}, {
  groupId: "Group identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZGROUP); refers to groups.id within this source.",
  contactId: "Member contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZCONTACT); refers to contacts.id within this source.",
  propertyName: "The contact property the choice is for, as stored in AddressBook ZABCDDISTRIBUTIONLISTCONFIG.ZPROPERTYNAME (Email for an email address choice, as a live store shows); part of the key. Other values are not verified.",
  emailId: "Chosen email address: the record ZABCDDISTRIBUTIONLISTCONFIG.ZEMAIL references, resolved to that ZABCDEMAILADDRESS record's ZUNIQUEID. Join to emailAddresses.id within this source. NULL when unset or no record matches.",
  phoneId: "Chosen phone number: the record ZABCDDISTRIBUTIONLISTCONFIG.ZPHONE references, resolved to that ZABCDPHONENUMBER record's ZUNIQUEID. Join to phoneNumbers.id within this source. NULL when unset or no record matches.",
  addressId: "Chosen postal address: the record ZABCDDISTRIBUTIONLISTCONFIG.ZADDRESS references, resolved to that ZABCDPOSTALADDRESS record's ZUNIQUEID. Join to postalAddresses.id within this source. NULL when unset or no record matches."
});
var DistributionListConfigsStream = class extends AppleContactsStream {
  name = "distributionListConfigs";
  primaryKey = ["groupId", "contactId", "propertyName"];
  jsonSchema = {
    type: "object",
    description: `One row per distribution-list choice in the AddressBook table ZABCDDISTRIBUTIONLISTCONFIG: which of member contactId's email addresses, phone numbers or postal addresses group groupId uses for that member, as set by Contacts' Edit Distribution List (ABGroup setDistributionIdentifier:forProperty:person:, which a live store saves here). A member without a row uses its default value. Primary key (groupId, contactId, propertyName), assumed unique since the store does not enforce it. emailId, phoneId and addressId refer to emailAddresses.id, phoneNumbers.id and postalAddresses.id within this source. ${localStores}`,
    properties: properties9,
    required: Object.keys(properties9)
  };
  rows(store) {
    return store.distributionListConfigs();
  }
  accepts(row, selection) {
    return selection.group(row.groupId) && selection.contact(row.contactId);
  }
  records(row) {
    return [
      {
        groupId: row.groupId,
        contactId: row.contactId,
        propertyName: encode(row.propertyName),
        emailId: row.emailId,
        phoneId: row.phoneId,
        addressId: row.addressId
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/email-addresses-stream.js
var properties10 = labeledFields(emailAddressView);
var EmailAddressesStream = class extends LabeledValueStream {
  name = "emailAddresses";
  jsonSchema = {
    type: "object",
    description: `One row per email address of a contact, a labeled value in the AddressBook table ZABCDEMAILADDRESS. ${labeledValue} distributionListConfigs.emailId refers to id. ${localStores}`,
    properties: properties10,
    required: Object.keys(properties10)
  };
  view = emailAddressView;
  rows(store) {
    return store.emailAddresses();
  }
};

// packages/sources/apple/contacts/dist/streams/group-members-stream.js
var properties11 = explained({
  groupId: eventKitFields.id,
  contactId: eventKitFields.id
}, {
  groupId: "Group identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_19PARENTGROUPS1); refers to groups.id within this source.",
  contactId: "Member contact identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_22CONTACTS); refers to contacts.id within this source. A contact can belong to many groups."
});
var GroupMembersStream = class extends AppleContactsStream {
  name = "groupMembers";
  primaryKey = ["groupId", "contactId"];
  jsonSchema = {
    type: "object",
    description: `One row per group membership stored in the AddressBook table Z_22PARENTGROUPS. Primary key (groupId, contactId). Only stored memberships appear; the connector does not evaluate smart group criteria. ${localStores}`,
    properties: properties11,
    required: Object.keys(properties11)
  };
  rows(store) {
    return store.groupMembers();
  }
  accepts(row, selection) {
    return selection.group(row.groupId) && selection.contact(row.contactId);
  }
  records(row) {
    return [{ groupId: row.groupId, contactId: row.contactId }];
  }
};

// packages/sources/apple/contacts/dist/streams/group-subgroups-stream.js
var properties12 = explained({
  parentGroupId: eventKitFields.id,
  childGroupId: eventKitFields.id
}, {
  parentGroupId: "Parent group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_19PARENTGROUPS); refers to groups.id within this source.",
  childGroupId: "Child group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_18CHILDGROUPS); refers to groups.id within this source."
});
var GroupSubgroupsStream = class extends AppleContactsStream {
  name = "groupSubgroups";
  primaryKey = ["parentGroupId", "childGroupId"];
  jsonSchema = {
    type: "object",
    description: `One row per direct parent-child link between groups stored in the AddressBook table Z_18PARENTGROUPS. Primary key (parentGroupId, childGroupId), both groups.id within this source. Deeper nesting is a chain of rows; a child can have several parents. ${localStores}`,
    properties: properties12,
    required: Object.keys(properties12)
  };
  rows(store) {
    return store.groupSubgroups();
  }
  accepts(row, selection) {
    return selection.group(row.parentGroupId) && selection.group(row.childGroupId);
  }
  records(row) {
    return [
      { parentGroupId: row.parentGroupId, childGroupId: row.childGroupId }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/groups-stream.js
var kinds3 = {
  ABCDGroup: "group",
  ABCDSubscribedGroup: "subscribedGroup",
  ABCDSmartGroup: "smartGroup"
};
var naming6 = { renames: { container: "containerId" } };
var properties13 = explained({
  id: eventKitFields.id,
  kind: entityKind(kinds3),
  ...attributeFields(groupView, naming6),
  ...attributeFields(recordView)
}, {
  id: "Group identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. groupMembers.groupId, groupSubgroups.parentGroupId, groupSubgroups.childGroupId and distributionListConfigs.groupId refer to it.",
  containerId: "Owning container: AddressBook ZABCDRECORD.ZCONTAINER resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches."
});
var GroupsStream = class extends AppleContactsStream {
  name = "groups";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: `One row per group record: an ABCDGroup, ABCDSubscribedGroup or ABCDSmartGroup, told apart by kind. Primary key id; containerId refers to containers.id. Stored members are in groupMembers, stored nesting in groupSubgroups and per-member address choices in distributionListConfigs. ${localStores}`,
    properties: properties13,
    required: Object.keys(properties13)
  };
  rows(store) {
    return store.groups();
  }
  accepts(row, selection) {
    return selection.group(row.id);
  }
  records(row) {
    return [
      {
        id: row.id,
        kind: row.entity === null ? null : kinds3[row.entity],
        ...attributeRecord(groupView, row.values, naming6),
        ...attributeRecord(recordView, row.values)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/images-stream.js
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
var { id: id2, text: text4, nullableText: nullableText3 } = eventKitFields;
async function sha256(data) {
  const hash = createHash("sha256");
  if (data.storage === "inline")
    hash.update(data.bytes);
  else
    for await (const chunk of createReadStream(data.path))
      hash.update(chunk);
  return hash.digest("hex");
}
var properties14 = {
  contactId: {
    ...id2,
    description: "Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; refers to contacts.id within this source. Part of the primary key with kind."
  },
  kind: {
    ...text4,
    enum: ["image", "thumbnail"],
    description: "Which stored image this row is: image for ZABCDRECORD.ZIMAGEDATA, thumbnail for ZABCDRECORD.ZTHUMBNAILIMAGEDATA. Part of the primary key with contactId."
  },
  storage: {
    ...text4,
    enum: ["inline", "external"],
    description: "Where Contacts keeps the bytes in its own store: inline inside the database column, or external in a file under the store's .AddressBook-v22_SUPPORT/_EXTERNAL_DATA directory. It describes the native source, not an exported file."
  },
  externalId: {
    ...nullableText3,
    description: "Contacts' storage identifier for external bytes: the file name under .AddressBook-v22_SUPPORT/_EXTERNAL_DATA recorded in the column. NULL when storage is inline. It is not an exported file."
  },
  byteLength: {
    type: "integer",
    minimum: 0,
    description: "Size in bytes of the stored image: the inline bytes after the storage marker, or the external file. Computed by this connector at extraction."
  },
  sha256: {
    ...text4,
    description: "Lowercase hexadecimal SHA-256 of the same bytes byteLength counts, computed by this connector at extraction."
  }
};
var ImagesStream = class extends AppleContactsStream {
  name = "images";
  primaryKey = ["contactId", "kind"];
  supportsFileTransfer = true;
  jsonSchema = {
    type: "object",
    description: `One row per stored contact image, from AddressBook ZABCDRECORD.ZIMAGEDATA (kind image) and ZTHUMBNAILIMAGEDATA (kind thumbnail): at most two rows per contact. Primary key (contactId, kind); contactId refers to contacts.id. byteLength and sha256 are computed from the bytes when extracted; a stored external file that cannot be read fails the extraction instead of producing a row. ${localStores}`,
    properties: properties14,
    required: Object.keys(properties14)
  };
  rows(store) {
    return store.images();
  }
  accepts(row, selection) {
    return selection.contact(row.contactId);
  }
  // The stored data stays in the scan, for the files the read hands over.
  async records(row, _store, scan) {
    const records = [];
    for (const kind of ["image", "thumbnail"]) {
      const data = row[kind]();
      if (data === null)
        continue;
      scan.images.set(imageKey(row.contactId, kind), data);
      records.push({
        contactId: row.contactId,
        kind,
        storage: data.storage,
        externalId: data.storage === "external" ? data.id : null,
        byteLength: data.storage === "inline" ? data.bytes.length : (await stat(data.path)).size,
        sha256: await sha256(data)
      });
    }
    return records;
  }
};

// packages/sources/apple/contacts/dist/streams/likenesses-stream.js
var properties15 = labeledFields(likenessView);
var LikenessesStream = class extends LabeledValueStream {
  name = "likenesses";
  jsonSchema = {
    type: "object",
    description: `One row per likeness value of a contact, a labeled value in the AddressBook table ZABCDLIKENESS; kind, version and data are exported as stored and their meaning is not documented by Apple. ${labeledValue} ${localStores}`,
    properties: properties15,
    required: Object.keys(properties15)
  };
  view = likenessView;
  rows(store) {
    return store.likenesses();
  }
};

// packages/sources/apple/contacts/dist/streams/messaging-addresses-stream.js
var properties16 = explained({
  ...labeledFields(messagingAddressView),
  service: eventKitFields.nullableText
}, {
  service: "Service name as stored: AddressBook ZABCDSERVICE.ZSERVICENAME of the service record ZABCDMESSAGINGADDRESS.ZSERVICE references, such as SkypeInstant; NULL when unset or no service record matches."
});
var MessagingAddressesStream = class extends LabeledValueStream {
  name = "messagingAddresses";
  jsonSchema = {
    type: "object",
    description: `One row per instant messaging address of a contact, a labeled value in the AddressBook table ZABCDMESSAGINGADDRESS. ${labeledValue} ${localStores}`,
    properties: properties16,
    required: Object.keys(properties16)
  };
  view = messagingAddressView;
  rows(store) {
    return store.messagingAddresses();
  }
  records(row) {
    return super.records(row).map((record) => ({
      ...record,
      service: row.service
    }));
  }
};

// packages/sources/apple/contacts/dist/streams/notes-stream.js
var properties17 = explained({ contactId: eventKitFields.id, ...attributeFields(noteView) }, {
  contactId: "Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDNOTE.ZCONTACT); the primary key. Refers to contacts.id within this source."
});
var NotesStream = class extends AppleContactsStream {
  name = "notes";
  primaryKey = ["contactId"];
  jsonSchema = {
    type: "object",
    description: `One row per contact that has a note record in the AddressBook table ZABCDNOTE. Primary key contactId, which refers to contacts.id; one note per contact is assumed, since the store does not enforce it. ${localStores}`,
    properties: properties17,
    required: Object.keys(properties17)
  };
  rows(store) {
    return store.notes();
  }
  accepts(row, selection) {
    return selection.contact(row.contactId);
  }
  records(row) {
    return [
      { contactId: row.contactId, ...attributeRecord(noteView, row.values) }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/phone-numbers-stream.js
var properties18 = labeledFields(phoneNumberView);
var PhoneNumbersStream = class extends LabeledValueStream {
  name = "phoneNumbers";
  jsonSchema = {
    type: "object",
    description: `One row per phone number of a contact, a labeled value in the AddressBook table ZABCDPHONENUMBER. ${labeledValue} distributionListConfigs.phoneId refers to id. ${localStores}`,
    properties: properties18,
    required: Object.keys(properties18)
  };
  view = phoneNumberView;
  rows(store) {
    return store.phoneNumbers();
  }
};

// packages/sources/apple/contacts/dist/streams/postal-addresses-stream.js
var properties19 = labeledFields(postalAddressView);
var PostalAddressesStream = class extends LabeledValueStream {
  name = "postalAddresses";
  jsonSchema = {
    type: "object",
    description: `One row per postal address of a contact, a labeled value in the AddressBook table ZABCDPOSTALADDRESS. ${labeledValue} distributionListConfigs.addressId refers to id. ${localStores}`,
    properties: properties19,
    required: Object.keys(properties19)
  };
  view = postalAddressView;
  rows(store) {
    return store.postalAddresses();
  }
};

// packages/sources/apple/contacts/dist/streams/related-names-stream.js
var properties20 = labeledFields(relatedNameView);
var RelatedNamesStream = class extends LabeledValueStream {
  name = "relatedNames";
  jsonSchema = {
    type: "object",
    description: `One row per related name of a contact, a labeled value in the AddressBook table ZABCDRELATEDNAME. ${labeledValue} ${localStores}`,
    properties: properties20,
    required: Object.keys(properties20)
  };
  view = relatedNameView;
  rows(store) {
    return store.relatedNames();
  }
};

// packages/sources/apple/contacts/dist/streams/remote-locations-stream.js
var naming7 = { renames: { owner: "recordId" } };
var properties21 = explained({
  id: eventKitFields.id,
  ...attributeFields(remoteLocationView, naming7)
}, {
  id: "Remote location identifier, AddressBook ZABCDREMOTELOCATION.ZUNIQUEID; the primary key.",
  recordId: "Owning record: ZABCDREMOTELOCATION.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches."
});
var RemoteLocationsStream = class extends AppleContactsStream {
  name = "remoteLocations";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: `One row per remote location record in the AddressBook table ZABCDREMOTELOCATION, on any record. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. ${localStores}`,
    properties: properties21,
    required: Object.keys(properties21)
  };
  rows(store) {
    return store.remoteLocations();
  }
  accepts(row, selection) {
    return selection.record(row.values.owner);
  }
  records(row) {
    return [
      {
        id: row.id,
        ...attributeRecord(remoteLocationView, row.values, naming7)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/social-profiles-stream.js
var properties22 = labeledFields(socialProfileView);
var SocialProfilesStream = class extends LabeledValueStream {
  name = "socialProfiles";
  jsonSchema = {
    type: "object",
    description: `One row per social profile of a contact, a labeled value in the AddressBook table ZABCDSOCIALPROFILE. ${labeledValue} ${localStores}`,
    properties: properties22,
    required: Object.keys(properties22)
  };
  view = socialProfileView;
  rows(store) {
    return store.socialProfiles();
  }
};

// packages/sources/apple/contacts/dist/streams/unknown-properties-stream.js
var properties23 = explained({
  recordId: eventKitFields.id,
  propertyName: eventKitFields.text,
  originalLine: eventKitFields.text
}, {
  recordId: "Owning record identifier (ZABCDRECORD.ZUNIQUEID of ZABCDUNKNOWNPROPERTY.ZOWNER). Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export.",
  propertyName: "vCard property name as stored in AddressBook ZABCDUNKNOWNPROPERTY.ZPROPERTYNAME.",
  originalLine: "The original vCard line from AddressBook ZABCDUNKNOWNPROPERTY.ZORIGINALLINE, which stores bytes: exported as Base64 of those bytes, so decoding it recovers the exact line, unless those bytes form a binary property list, which loads as JSON instead. Text the store holds as text passes through unchanged."
});
var UnknownPropertiesStream = class extends AppleContactsStream {
  name = "unknownProperties";
  primaryKey = ["recordId", "propertyName", "originalLine"];
  jsonSchema = {
    type: "object",
    description: `One row per distinct vCard line that Contacts kept without interpreting it, from the AddressBook table ZABCDUNKNOWNPROPERTY. The native rows have no identifier, so the primary key is (recordId, propertyName, originalLine); the same line stored twice on one record is one row. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. ${localStores}`,
    properties: properties23,
    required: Object.keys(properties23)
  };
  rows(store) {
    return store.unknownProperties();
  }
  accepts(row, selection) {
    return selection.record(row.recordId);
  }
  records(row) {
    return [
      {
        recordId: row.recordId,
        propertyName: encode(row.propertyName),
        originalLine: encode(row.originalLine)
      }
    ];
  }
};

// packages/sources/apple/contacts/dist/streams/url-addresses-stream.js
var properties24 = labeledFields(urlAddressView);
var UrlAddressesStream = class extends LabeledValueStream {
  name = "urlAddresses";
  jsonSchema = {
    type: "object",
    description: `One row per URL of a contact, a labeled value in the AddressBook table ZABCDURLADDRESS. ${labeledValue} ${localStores}`,
    properties: properties24,
    required: Object.keys(properties24)
  };
  view = urlAddressView;
  rows(store) {
    return store.urlAddresses();
  }
};

// packages/sources/apple/contacts/dist/apple-contacts-source.js
var readers = {
  containers: new ContainersStream(),
  groups: new GroupsStream(),
  groupMembers: new GroupMembersStream(),
  groupSubgroups: new GroupSubgroupsStream(),
  contacts: new ContactsStream(),
  notes: new NotesStream(),
  alternateBirthdays: new AlternateBirthdaysStream(),
  phoneNumbers: new PhoneNumbersStream(),
  emailAddresses: new EmailAddressesStream(),
  postalAddresses: new PostalAddressesStream(),
  urlAddresses: new UrlAddressesStream(),
  socialProfiles: new SocialProfilesStream(),
  messagingAddresses: new MessagingAddressesStream(),
  relatedNames: new RelatedNamesStream(),
  contactDates: new ContactDatesStream(),
  calendarUris: new CalendarUrisStream(),
  addressingGrammars: new AddressingGrammarsStream(),
  likenesses: new LikenessesStream(),
  alertTones: new AlertTonesStream(),
  customPropertyValues: new CustomPropertyValuesStream(),
  remoteLocations: new RemoteLocationsStream(),
  unknownProperties: new UnknownPropertiesStream(),
  distributionListConfigs: new DistributionListConfigsStream(),
  images: new ImagesStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var AppleContactsSource = class extends Source {
  identity;
  catalog = catalog;
  containers = readers.containers.describe();
  groups = readers.groups.describe();
  groupMembers = readers.groupMembers.describe();
  groupSubgroups = readers.groupSubgroups.describe();
  contacts = readers.contacts.describe();
  notes = readers.notes.describe();
  alternateBirthdays = readers.alternateBirthdays.describe();
  phoneNumbers = readers.phoneNumbers.describe();
  emailAddresses = readers.emailAddresses.describe();
  postalAddresses = readers.postalAddresses.describe();
  urlAddresses = readers.urlAddresses.describe();
  socialProfiles = readers.socialProfiles.describe();
  messagingAddresses = readers.messagingAddresses.describe();
  relatedNames = readers.relatedNames.describe();
  contactDates = readers.contactDates.describe();
  calendarUris = readers.calendarUris.describe();
  addressingGrammars = readers.addressingGrammars.describe();
  likenesses = readers.likenesses.describe();
  alertTones = readers.alertTones.describe();
  customPropertyValues = readers.customPropertyValues.describe();
  remoteLocations = readers.remoteLocations.describe();
  unknownProperties = readers.unknownProperties.describe();
  distributionListConfigs = readers.distributionListConfigs.describe();
  images = readers.images.describe();
  directory;
  scope;
  #store;
  constructor(directory = addressBookDirectory, scope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.#store = new ContactsStore(directory);
    this.identity = `apple-contacts:${directory}`;
    Object.freeze(this);
  }
  async open() {
    return new ContactsScan(await this.#store.open(), this.scope);
  }
  failureType(error) {
    return error instanceof ContactsUnavailableError ? "config" : "system";
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
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
    var _stack = [];
    try {
      const { stream } = configuration;
      const reader = readersByName.get(stream.name);
      if (reader === void 0)
        throw new TypeError(`Contacts has no stream ${stream.name}`);
      const records = await reader.read(scan);
      const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
      if (configuration.fileReads.length === 0 || reader !== readers.images) {
        yield* messages;
        return;
      }
      const staging = __using(_stack, await mkdtempDisposable(join4(tmpdir(), "elt-contacts-")), true);
      let staged = 0;
      for await (const message of messages) {
        if ("type" in message) {
          yield message;
          continue;
        }
        const data = scan.images.get(imageKey(message.data.contactId, message.data.kind));
        if (data === void 0)
          throw new TypeError("Contacts image record lost its stored data");
        if (data.storage === "external") {
          yield { ...message, file: data.path };
          continue;
        }
        const path = join4(staging.path, String(staged++));
        await writeFile(path, data.bytes);
        yield { ...message, file: path };
        await rm(path);
      }
    } catch (_) {
      var _error = _, _hasError = true;
    } finally {
      var _promise = __callDispose(_stack, _error, _hasError);
      _promise && await _promise;
    }
  }
};

// packages/connectors/apple/contacts/dist/contacts-connector.js
var ContactsConnector = class extends AppleConnector {
  datedBy = null;
  fullDiskAccess = false;
  choices = [
    {
      stream: "containers",
      scope: "collectionIds",
      title: "accounts",
      id: byId,
      label: name
    }
  ];
  unscoped = [];
  storeCopies = [];
  access(grantee) {
    return `Allow ${grantee} when macOS asks for Contacts access, or turn it on in System Settings \u203A Privacy & Security \u203A Contacts. Full Disk Access for ${grantee} also works.`;
  }
  source(scope) {
    return new AppleContactsSource(void 0, scope);
  }
};
export {
  ContactsConnector as default
};
