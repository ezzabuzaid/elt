import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  decodeArchive,
  isBinaryPlist,
  plistJSON
} from "../../chunks/chunk-462G4OOY.mjs";
import {
  selected
} from "../../chunks/chunk-YDCQQEHM.mjs";
import {
  byId,
  name
} from "../../chunks/chunk-PCDODET2.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-TDOTZXB7.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-4HBD6YP5.mjs";
import {
  AppleApp
} from "../../chunks/chunk-PLJTWAM2.mjs";
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

// apps/apple/connectors/dist/sources/apple-contacts/apple-contacts-source.js
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtempDisposable, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";
import { setInterval } from "node:timers/promises";

// apps/apple/connectors/dist/platform/macos/address-book.js
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
var addressBookDirectory = join(homedir(), "Library/Application Support/AddressBook");
var storeFile = "AddressBook-v22.abcddb";
var ContactsUnavailableError = class extends Error {
  name = "ContactsUnavailableError";
  constructor(path, cause) {
    super(`The Contacts store at ${path} cannot be read. Allow the process that runs the export Contacts access or Full Disk Access in System Settings > Privacy & Security; macOS attributes a child process to the app or launchd job that started it. Contacts.app does not need to be open.`, { cause });
  }
};
var ContactsSchemaError = class extends Error {
  name = "ContactsSchemaError";
  constructor(path, missing) {
    super(`The Contacts store at ${path} has a layout this connector does not read (missing ${missing.join(", ")}).`);
  }
};
var unavailableCodes = /* @__PURE__ */ new Set([14, 23]);
var open = (path) => {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    if (cause instanceof Error && "errcode" in cause && unavailableCodes.has(Number(cause.errcode)))
      throw new ContactsUnavailableError(path, cause);
    throw cause;
  }
};
function storeDirectories(directory) {
  const sources = join(directory, "Sources");
  let entries;
  try {
    entries = readdirSync(sources, { withFileTypes: true });
  } catch (cause) {
    throw new ContactsUnavailableError(sources, cause);
  }
  return [
    { source: null, directory },
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().map((source) => ({ source, directory: join(sources, source) }))
  ];
}
var AddressBookStore = class {
  // The Sources directory name, or null for the On My Mac store.
  source;
  directory;
  #database;
  constructor(source, directory, database) {
    this.source = source;
    this.directory = directory;
    this.#database = database;
  }
  get path() {
    return join(this.directory, storeFile);
  }
  all(sql) {
    return this.#database.prepare(sql).all();
  }
  storedData(value) {
    if (value[0] === 1)
      return { storage: "inline", bytes: value.subarray(1) };
    if (value[0] === 2) {
      const end = value.indexOf(0, 1);
      const id2 = Buffer.from(value.subarray(1, end === -1 ? value.length : end)).toString("ascii");
      return {
        storage: "external",
        id: id2,
        path: join(this.directory, ".AddressBook-v22_SUPPORT/_EXTERNAL_DATA", id2)
      };
    }
    throw new TypeError(`Contacts store ${this.path} holds data in an unknown encoding (first byte ${value[0]})`);
  }
  close() {
    if (this.#database.isOpen) {
      if (this.#database.isTransaction)
        this.#database.exec("COMMIT");
      this.#database.close();
    }
  }
};
var AddressBook = class _AddressBook {
  stores;
  constructor(stores) {
    this.stores = stores;
  }
  static async open(directory, required2) {
    const stores = [];
    try {
      for (const store of storeDirectories(directory)) {
        const path = join(store.directory, storeFile);
        const database = open(path);
        stores.push(new AddressBookStore(store.source, store.directory, database));
        database.exec("BEGIN");
        const missing = Object.entries(required2.columns).flatMap(([table, columns]) => {
          const present = new Set(database.prepare("SELECT name FROM pragma_table_info(?)").all(table).map((column) => column.name));
          return columns.filter((column) => !present.has(column)).map((column) => `${table}.${column}`);
        });
        if (missing.length === 0) {
          const entities2 = new Set(database.prepare("SELECT Z_NAME FROM Z_PRIMARYKEY").all().map((entity) => entity.Z_NAME));
          for (const entity of required2.entities)
            if (!entities2.has(entity))
              missing.push(`entity ${entity}`);
        }
        if (missing.length > 0)
          throw new ContactsSchemaError(path, missing);
      }
      return new _AddressBook(stores);
    } catch (cause) {
      for (const store of stores)
        store.close();
      throw cause;
    }
  }
  async [Symbol.asyncDispose]() {
    for (const store of this.stores)
      store.close();
  }
};
var AddressBookVersion = class {
  #stores = /* @__PURE__ */ new Map();
  directory;
  constructor(directory) {
    this.directory = directory;
  }
  get current() {
    const paths = storeDirectories(this.directory).map(({ directory }) => join(directory, storeFile));
    for (const [path, { database }] of this.#stores)
      if (!paths.includes(path)) {
        database.close();
        this.#stores.delete(path);
      }
    return JSON.stringify(paths.map((path) => {
      let store = this.#stores.get(path);
      if (store === void 0) {
        const database = open(path);
        store = {
          database,
          version: database.prepare("PRAGMA data_version")
        };
        this.#stores.set(path, store);
      }
      return [path, Number(store.version.get()?.data_version)];
    }));
  }
  [Symbol.dispose]() {
    for (const { database } of this.#stores.values())
      database.close();
    this.#stores.clear();
  }
};

// apps/apple/connectors/dist/sources/apple-contacts/contacts-streams.js
var { text, id, nullableText, nullableTimestamp } = eventKitFields;
var nullableInteger = { type: ["integer", "null"] };
var nullableNumber = { type: ["number", "null"] };
var nullableBoolean = { type: ["boolean", "null"] };
var appleEpoch = 978307200;
var instant = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} + ${appleEpoch}, 'unixepoch')`;
var words = (list = "") => list.split(/\s+/).filter(Boolean);
var kinds = {
  text: (column) => [nullableText, column],
  integer: (column) => [nullableInteger, column],
  boolean: (column) => [nullableBoolean, column],
  number: (column) => [nullableNumber, column],
  timestamp: (column) => [nullableTimestamp, instant(column)],
  data: (column) => [nullableText, column],
  record: (column) => [
    nullableText,
    `(SELECT o.ZUNIQUEID FROM ZABCDRECORD o WHERE o.Z_PK = ${column})`
  ]
};
var isKind = (name2) => Object.hasOwn(kinds, name2);
var conversions = {
  text: "as stored",
  integer: "as stored",
  number: "as stored",
  boolean: "with 0 read as false and any other stored value as true",
  timestamp: "Core Data seconds since 2001-01-01 converted to a UTC instant with millisecond precision",
  data: "a binary property list as JSON (keyed archives unarchived, nested bytes as Base64), other bytes as Base64",
  record: "a ZABCDRECORD reference resolved to that record's ZUNIQUEID"
};
var unverified = "Meaning not verified: Apple does not document this store.";
function provenance(kind, table, column) {
  const absent = kind === "record" ? "NULL when unset or no record matches" : "NULL when the store holds no value";
  return `AddressBook ${table}.${column}, ${conversions[kind]}; ${absent}. ${unverified}`;
}
function explained(fields, meanings) {
  const described = { ...fields };
  for (const [name2, description] of Object.entries(meanings)) {
    const field = fields[name2];
    if (field === void 0)
      throw new TypeError(`Contacts has no field ${name2} to describe`);
    described[name2] = [{ ...field[0], description }, field[1]];
  }
  return described;
}
var required = /* @__PURE__ */ new Map();
var requiredEntities = /* @__PURE__ */ new Set();
function requires(table, columns) {
  const present = required.get(table) ?? /* @__PURE__ */ new Set();
  required.set(table, present);
  for (const column of words(columns))
    present.add(column);
}
function attributes(table, alias, list) {
  const fields = {};
  for (const [kind, names] of Object.entries(list)) {
    if (!isKind(kind))
      throw new TypeError(`Contacts has no column kind ${kind}`);
    for (const token of words(names)) {
      const [name2 = token, column = `Z${name2.toUpperCase()}`] = token.split(":");
      requires(table, column);
      const [schema, sql] = kinds[kind](`${alias}.${column}`);
      fields[name2] = [
        { ...schema, description: provenance(kind, table, column) },
        sql
      ];
    }
  }
  return fields;
}
function calendarDate(table, alias, attribute, [year, month, day]) {
  const column = `Z${attribute.toUpperCase()}`;
  requires(table, column);
  const part = (format) => `CAST(strftime('${format}', ${alias}.${column} + ${appleEpoch}, 'unixepoch') AS INTEGER)`;
  const read = `of the date in AddressBook ${table}.${column}, Core Data seconds since 2001-01-01 read as a Gregorian UTC date`;
  return {
    [year]: [
      {
        ...nullableInteger,
        description: `Year ${read}; NULL when no date is stored or its year is 1604, the year Contacts stores for a date without a year.`
      },
      `CASE WHEN ${part("%Y")} = 1604 THEN NULL ELSE ${part("%Y")} END`
    ],
    [month]: [
      {
        ...nullableInteger,
        description: `Month (1-12) ${read}; NULL when no date is stored.`
      },
      part("%m")
    ],
    [day]: [
      {
        ...nullableInteger,
        description: `Day of the month ${read}; NULL when no date is stored.`
      },
      part("%d")
    ]
  };
}
var record = (alias) => attributes("ZABCDRECORD", alias, {
  timestamp: "creationDate modificationDate",
  integer: "displayFlags syncStatus iOSLegacyIdentifier",
  text: "externalCollectionPath externalFilename externalHash externalImageURI externalModificationTag externalURI externalUUID",
  data: "externalRepresentation"
});
function entities(alias, names) {
  requires("ZABCDRECORD", "Z_PK Z_ENT ZUNIQUEID");
  requires("Z_PRIMARYKEY", "Z_ENT Z_NAME");
  for (const name2 of Object.keys(names))
    requiredEntities.add(name2);
  const list = Object.keys(names).map((name2) => `'${name2}'`).join(", ");
  const meanings = Object.entries(names).map(([name2, kind]) => `${kind} for ${name2}`).join(", ");
  return {
    join: `JOIN Z_PRIMARYKEY ${alias}_entity ON ${alias}_entity.Z_ENT = ${alias}.Z_ENT AND ${alias}_entity.Z_NAME IN (${list})`,
    kind: [
      {
        ...text,
        enum: Object.values(names),
        description: `Core Data entity of this record, from Z_PRIMARYKEY.Z_NAME: ${meanings}. Apple does not document how these entities differ.`
      },
      `CASE ${alias}_entity.Z_NAME ${Object.entries(names).map(([name2, kind]) => `WHEN '${name2}' THEN '${kind}'`).join(" ")} END`
    ]
  };
}
var contact = entities("c", {
  ABCDContact: "contact",
  ABCDSubscribedContact: "subscribedContact"
});
var group = entities("g", {
  ABCDGroup: "group",
  ABCDSubscribedGroup: "subscribedGroup",
  ABCDSmartGroup: "smartGroup"
});
var container = entities("r", { CNCDContainer: "container" });
function labeled(table, alias, list) {
  requires(table, "ZUNIQUEID");
  return explained({
    id: [id, `${alias}.ZUNIQUEID`],
    ...attributes(table, alias, {
      record: "contactId:ZOWNER",
      text: "label",
      boolean: "isPrimary isPrivate",
      integer: "orderingIndex iOSLegacyIdentifier"
    }),
    ...attributes(table, alias, list)
  }, {
    id: `Identifier of this labeled value, AddressBook ${table}.ZUNIQUEID; the primary key.`,
    contactId: `Owning contact: ${table}.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source; a contact can have many of these values. NULL when unset or no record matches.`,
    label: `Label from AddressBook ${table}.ZLABEL, as stored and not localized: a built-in label is a token such as _$!<Mobile>!$_, a custom label is its own text. NULL when the store holds no value; it can also be empty text.`
  });
}
var labeledValue = "Primary key id; contactId refers to contacts.id, and a contact can have several. label is the stored, unlocalized label. isPrimary, isPrivate and orderingIndex pass through as stored; whether orderingIndex orders a contact's values densely or uniquely is not verified.";
var localStores = "Read from this Mac's Contacts stores, On My Mac and one per account under AddressBook/Sources, so it holds what has synced to this Mac rather than a complete cloud account; a configured container selection limits it further. Relationships name source streams, not destination tables, and identifiers name native records, not people merged across stores.";
function definition(description, fields, from, primaryKey, { distinct = false } = {}) {
  return {
    description,
    properties: Object.fromEntries(Object.entries(fields).map(([name2, [schema]]) => [name2, schema])),
    primaryKey,
    sql: `SELECT ${distinct ? "DISTINCT " : ""}${Object.entries(fields).map(([name2, [, sql]]) => `${sql} AS "${name2}"`).join(", ")} FROM ${from}`
  };
}
requires("Z_22PARENTGROUPS", "Z_22CONTACTS Z_19PARENTGROUPS1");
requires("Z_18PARENTGROUPS", "Z_18CHILDGROUPS Z_19PARENTGROUPS");
requires("ZABCDNOTE", "ZCONTACT");
requires("ZABCDDATECOMPONENTS", "ZCONTACT");
requires("ZABCDMESSAGINGADDRESS", "ZSERVICE");
requires("ZABCDSERVICE", "Z_PK ZSERVICENAME");
requires("ZABCDCUSTOMPROPERTY", "Z_PK");
requires("ZABCDCUSTOMPROPERTYVALUE", "ZUNIQUEID ZCUSTOMPROPERTY");
requires("ZABCDREMOTELOCATION", "ZUNIQUEID");
requires("ZABCDUNKNOWNPROPERTY", "ZOWNER");
requires("ZABCDDISTRIBUTIONLISTCONFIG", "ZGROUP ZCONTACT ZEMAIL ZPHONE ZADDRESS");
requires("ZABCDEMAILADDRESS", "Z_PK");
requires("ZABCDPHONENUMBER", "Z_PK");
requires("ZABCDPOSTALADDRESS", "Z_PK");
var uniqueIdOf = (table, column) => [
  nullableText,
  `(SELECT x.ZUNIQUEID FROM ${table} x WHERE x.Z_PK = ${column})`
];
var definitions = {
  containers: definition("One row per Contacts container, a CNCDContainer record in a store. Primary key id. contacts.containerId, contacts.meOfContainerId and groups.containerId refer to id.", explained({
    id: [id, "r.ZUNIQUEID"],
    // Filled per store.
    source: [nullableText, "NULL"],
    ...attributes("ZABCDRECORD", "r", {
      text: "name:ZNAME1 externalIdentifier providerIdentifier remoteLocation serialNumber",
      integer: "type guardianFlags",
      boolean: "isAll",
      timestamp: "lastSyncDate",
      record: "meContactId:ZME"
    }),
    ...record("r")
  }, {
    id: "Container identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key.",
    source: "Directory name under AddressBook/Sources of the account store this container was read from; NULL for the On My Mac store at the AddressBook root.",
    meContactId: "AddressBook ZABCDRECORD.ZME resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches."
  }), `ZABCDRECORD r ${container.join}`, ["id"]),
  groups: definition("One row per group record: an ABCDGroup, ABCDSubscribedGroup or ABCDSmartGroup, told apart by kind. Primary key id; containerId refers to containers.id. Stored members are in groupMembers, stored nesting in groupSubgroups and per-member address choices in distributionListConfigs.", explained({
    id: [id, "g.ZUNIQUEID"],
    kind: group.kind,
    ...attributes("ZABCDRECORD", "g", {
      record: "containerId:ZCONTAINER",
      text: "name tmpRemoteLocation",
      integer: "externalGroupBehavior",
      data: "modifiedUniqueIdsData searchElementData"
    }),
    ...record("g")
  }, {
    id: "Group identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. groupMembers.groupId, groupSubgroups.parentGroupId, groupSubgroups.childGroupId and distributionListConfigs.groupId refer to it.",
    containerId: "Owning container: AddressBook ZABCDRECORD.ZCONTAINER resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches."
  }), `ZABCDRECORD g ${group.join}`, ["id"]),
  groupMembers: definition("One row per group membership stored in the AddressBook table Z_22PARENTGROUPS. Primary key (groupId, contactId). Only stored memberships appear; the connector does not evaluate smart group criteria.", explained({ groupId: [id, "g.ZUNIQUEID"], contactId: [id, "c.ZUNIQUEID"] }, {
    groupId: "Group identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_19PARENTGROUPS1); refers to groups.id within this source.",
    contactId: "Member contact identifier (ZABCDRECORD.ZUNIQUEID of Z_22PARENTGROUPS.Z_22CONTACTS); refers to contacts.id within this source. A contact can belong to many groups."
  }), "Z_22PARENTGROUPS j JOIN ZABCDRECORD g ON g.Z_PK = j.Z_19PARENTGROUPS1 JOIN ZABCDRECORD c ON c.Z_PK = j.Z_22CONTACTS", ["groupId", "contactId"]),
  groupSubgroups: definition("One row per direct parent-child link between groups stored in the AddressBook table Z_18PARENTGROUPS. Primary key (parentGroupId, childGroupId), both groups.id within this source. Deeper nesting is a chain of rows; a child can have several parents.", explained({ parentGroupId: [id, "p.ZUNIQUEID"], childGroupId: [id, "g.ZUNIQUEID"] }, {
    parentGroupId: "Parent group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_19PARENTGROUPS); refers to groups.id within this source.",
    childGroupId: "Child group identifier (ZABCDRECORD.ZUNIQUEID of Z_18PARENTGROUPS.Z_18CHILDGROUPS); refers to groups.id within this source."
  }), "Z_18PARENTGROUPS j JOIN ZABCDRECORD p ON p.Z_PK = j.Z_19PARENTGROUPS JOIN ZABCDRECORD g ON g.Z_PK = j.Z_18CHILDGROUPS", ["parentGroupId", "childGroupId"]),
  contacts: definition("One row per contact record: an ABCDContact or ABCDSubscribedContact, told apart by kind. Primary key id; containerId refers to containers.id. Multi-valued details are separate streams keyed by their own id with contactId: phoneNumbers, emailAddresses, postalAddresses, urlAddresses, socialProfiles, messagingAddresses, relatedNames, contactDates, calendarUris, addressingGrammars and likenesses; alertTones, notes, alternateBirthdays and images also carry contactId, and groupMembers lists stored group membership. The same person in two stores is two rows; this source does not merge them.", explained({
    id: [id, "c.ZUNIQUEID"],
    kind: contact.kind,
    ...attributes("ZABCDRECORD", "c", {
      record: "containerId:ZCONTAINER1 meOfContainerId:ZCONTAINERWHERECONTACTISME",
      text: "title firstName middleName lastName suffix nickname maidenName phoneticFirstName phoneticMiddleName phoneticLastName phoneticOrganization phonemeData organization department jobTitle linkId identityUniqueId preferredApplePersonaIdentifier preferredLikenessSource imageType imageReference cropRect cropRectID wallpaperURI downtimeWhitelist tmpHomePage",
      integer: "privacyFlags",
      boolean: "preferredForLinkName preferredForLinkPhoto",
      timestamp: "imageSyncFailedTime wallpaperSyncFailedTime",
      data: "imageHash cropRectHash avatarRecipeData memojiMetadata sensitiveContentConfiguration wallpaper"
    }),
    ...calendarDate("ZABCDRECORD", "c", "birthday", [
      "birthdayYear",
      "birthdayMonth",
      "birthdayDay"
    ]),
    ...record("c")
  }, {
    id: "Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; the primary key. contactId fields in other streams of this source refer to it.",
    containerId: "Owning container: AddressBook ZABCDRECORD.ZCONTAINER1 resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches.",
    meOfContainerId: "AddressBook ZABCDRECORD.ZCONTAINERWHERECONTACTISME resolved to that record's ZUNIQUEID. Join to containers.id within this source. NULL when unset or no record matches."
  }), `ZABCDRECORD c ${contact.join}`, ["id"]),
  notes: definition("One row per contact that has a note record in the AddressBook table ZABCDNOTE. Primary key contactId, which refers to contacts.id; one note per contact is assumed, since the store does not enforce it.", explained({
    contactId: [id, "c.ZUNIQUEID"],
    ...attributes("ZABCDNOTE", "n", { text: "text", data: "richTextData" })
  }, {
    contactId: "Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDNOTE.ZCONTACT); the primary key. Refers to contacts.id within this source."
  }), "ZABCDNOTE n JOIN ZABCDRECORD c ON c.Z_PK = n.ZCONTACT", ["contactId"]),
  // The non-Gregorian birthday (CNContact.nonGregorianBirthday).
  alternateBirthdays: definition("One row per contact with a non-Gregorian birthday (CNContact.nonGregorianBirthday, which a live store saves here), as date components in the AddressBook table ZABCDDATECOMPONENTS. Primary key contactId, which refers to contacts.id; one record per contact is assumed, since the store does not enforce it. Components stay in the calendar named by calendarIdentifier and are not converted, so they do not compare with the contact's Gregorian birthdayYear, birthdayMonth and birthdayDay.", explained({
    contactId: [id, "c.ZUNIQUEID"],
    ...attributes("ZABCDDATECOMPONENTS", "d", {
      text: "uniqueId calendarIdentifier",
      integer: "era year month day iOSLegacyIdentifier",
      boolean: "isLeapMonth"
    })
  }, {
    contactId: "Owning contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDATECOMPONENTS.ZCONTACT); the primary key. Refers to contacts.id within this source.",
    uniqueId: "Native identifier of this date-components record, AddressBook ZABCDDATECOMPONENTS.ZUNIQUEID, as stored; no other stream refers to it.",
    calendarIdentifier: "Calendar identifier as stored in AddressBook ZABCDDATECOMPONENTS.ZCALENDARIDENTIFIER; names the calendar that era, year, month and day are counted in.",
    era: "Era component as stored in AddressBook ZABCDDATECOMPONENTS.ZERA, in the calendar named by calendarIdentifier; NULL when the store holds no value.",
    year: "Year component as stored in AddressBook ZABCDDATECOMPONENTS.ZYEAR, in the calendar named by calendarIdentifier and not converted; not comparable with contacts.birthdayYear. NULL when the store holds no value.",
    month: "Month component as stored in AddressBook ZABCDDATECOMPONENTS.ZMONTH, in the calendar named by calendarIdentifier; NULL when the store holds no value.",
    day: "Day component as stored in AddressBook ZABCDDATECOMPONENTS.ZDAY, in the calendar named by calendarIdentifier; NULL when the store holds no value."
  }), "ZABCDDATECOMPONENTS d JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT", ["contactId"]),
  phoneNumbers: definition(`One row per phone number of a contact, a labeled value in the AddressBook table ZABCDPHONENUMBER. ${labeledValue} distributionListConfigs.phoneId refers to id.`, labeled("ZABCDPHONENUMBER", "p", {
    text: "fullNumber countryCode areaCode localNumber extension"
  }), "ZABCDPHONENUMBER p", ["id"]),
  emailAddresses: definition(`One row per email address of a contact, a labeled value in the AddressBook table ZABCDEMAILADDRESS. ${labeledValue} distributionListConfigs.emailId refers to id.`, labeled("ZABCDEMAILADDRESS", "e", { text: "address" }), "ZABCDEMAILADDRESS e", ["id"]),
  postalAddresses: definition(`One row per postal address of a contact, a labeled value in the AddressBook table ZABCDPOSTALADDRESS. ${labeledValue} distributionListConfigs.addressId refers to id.`, labeled("ZABCDPOSTALADDRESS", "a", {
    text: "street subLocality city state region zipCode countryName countryCode sama",
    data: "customValuesDictionary"
  }), "ZABCDPOSTALADDRESS a", ["id"]),
  urlAddresses: definition(`One row per URL of a contact, a labeled value in the AddressBook table ZABCDURLADDRESS. ${labeledValue}`, labeled("ZABCDURLADDRESS", "u", { text: "url" }), "ZABCDURLADDRESS u", ["id"]),
  socialProfiles: definition(`One row per social profile of a contact, a labeled value in the AddressBook table ZABCDSOCIALPROFILE. ${labeledValue}`, labeled("ZABCDSOCIALPROFILE", "s", {
    text: "serviceName username userIdentifier urlString displayname bundleIdentifiersString teamIdentifier",
    data: "customValuesData"
  }), "ZABCDSOCIALPROFILE s", ["id"]),
  // Instant message addresses; service is ABCDService's name, such as SkypeInstant.
  messagingAddresses: definition(`One row per instant messaging address of a contact, a labeled value in the AddressBook table ZABCDMESSAGINGADDRESS. ${labeledValue}`, explained({
    ...labeled("ZABCDMESSAGINGADDRESS", "m", {
      text: "address userIdentifier bundleIdentifiersString teamIdentifier"
    }),
    service: [
      nullableText,
      "(SELECT s.ZSERVICENAME FROM ZABCDSERVICE s WHERE s.Z_PK = m.ZSERVICE)"
    ]
  }, {
    service: "Service name as stored: AddressBook ZABCDSERVICE.ZSERVICENAME of the service record ZABCDMESSAGINGADDRESS.ZSERVICE references, such as SkypeInstant; NULL when unset or no service record matches."
  }), "ZABCDMESSAGINGADDRESS m", ["id"]),
  relatedNames: definition(`One row per related name of a contact, a labeled value in the AddressBook table ZABCDRELATEDNAME. ${labeledValue}`, labeled("ZABCDRELATEDNAME", "n", { text: "name" }), "ZABCDRELATEDNAME n", ["id"]),
  contactDates: definition(`One row per labeled date of a contact in the AddressBook table ZABCDCONTACTDATE, split into Gregorian year, month and day; year is NULL for a date stored without a year. ${labeledValue}`, {
    ...labeled("ZABCDCONTACTDATE", "d", {}),
    ...calendarDate("ZABCDCONTACTDATE", "d", "date", [
      "year",
      "month",
      "day"
    ])
  }, "ZABCDCONTACTDATE d", ["id"]),
  calendarUris: definition(`One row per calendar URI of a contact, a labeled value in the AddressBook table ZABCDCALENDARURI. ${labeledValue}`, labeled("ZABCDCALENDARURI", "u", { text: "url" }), "ZABCDCALENDARURI u", ["id"]),
  addressingGrammars: definition(`One row per addressing grammar value of a contact, a labeled value in the AddressBook table ZABCDADDRESSINGGRAMMAR; the value is exported as stored and its format is not documented by Apple. ${labeledValue}`, labeled("ZABCDADDRESSINGGRAMMAR", "g", { text: "addressingGrammar" }), "ZABCDADDRESSINGGRAMMAR g", ["id"]),
  likenesses: definition(`One row per likeness value of a contact, a labeled value in the AddressBook table ZABCDLIKENESS; kind, version and data are exported as stored and their meaning is not documented by Apple. ${labeledValue}`, labeled("ZABCDLIKENESS", "l", {
    integer: "kind",
    text: "version",
    data: "data"
  }), "ZABCDLIKENESS l", ["id"]),
  alertTones: definition("One row per alert tone record of a contact in the AddressBook table ZABCDALERTTONE. Primary key id; contactId refers to contacts.id, and a contact can have several. type and toneData are exported as stored and their values are not documented by Apple.", explained({
    id: [id, "t.ZUNIQUEID"],
    ...attributes("ZABCDALERTTONE", "t", {
      record: "contactId:ZOWNER",
      text: "type toneData",
      integer: "iOSLegacyIdentifier"
    })
  }, {
    id: "Alert tone identifier, AddressBook ZABCDALERTTONE.ZUNIQUEID; the primary key.",
    contactId: "Owning contact: ZABCDALERTTONE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id within this source. NULL when unset or no record matches."
  }), "ZABCDALERTTONE t", ["id"]),
  // Values of custom properties, on any record, with their property's definition.
  customPropertyValues: definition("One row per custom property value in the AddressBook table ZABCDCUSTOMPROPERTYVALUE, on any record, with its property definition from ZABCDCUSTOMPROPERTY. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export. propertyName, recordType and valueType are NULL when the value has no definition record. Which of stringValue, numberValue, dateValue and dataValue holds the value is not verified against valueType.", explained({
    id: [id, "v.ZUNIQUEID"],
    ...attributes("ZABCDCUSTOMPROPERTY", "p", {
      text: "propertyName recordType",
      integer: "valueType"
    }),
    ...attributes("ZABCDCUSTOMPROPERTYVALUE", "v", {
      record: "recordId:ZOWNER",
      text: "label stringValue",
      boolean: "isPrimary isPrivate",
      integer: "orderingIndex iOSLegacyIdentifier dateValueYear",
      number: "numberValue",
      timestamp: "dateValue",
      data: "dataValue"
    })
  }, {
    id: "Custom property value identifier, AddressBook ZABCDCUSTOMPROPERTYVALUE.ZUNIQUEID; the primary key.",
    propertyName: `Property name as stored in AddressBook ZABCDCUSTOMPROPERTY.ZPROPERTYNAME, the definition ZABCDCUSTOMPROPERTYVALUE.ZCUSTOMPROPERTY references; NULL when the store holds no value or no definition record matches. ${unverified}`,
    recordType: `AddressBook ZABCDCUSTOMPROPERTY.ZRECORDTYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
    valueType: `AddressBook ZABCDCUSTOMPROPERTY.ZVALUETYPE of the referenced definition, as stored; NULL when the store holds no value or no definition record matches. ${unverified}`,
    recordId: "Owning record: ZABCDCUSTOMPROPERTYVALUE.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches."
  }), "ZABCDCUSTOMPROPERTYVALUE v LEFT JOIN ZABCDCUSTOMPROPERTY p ON p.Z_PK = v.ZCUSTOMPROPERTY", ["id"]),
  remoteLocations: definition("One row per remote location record in the AddressBook table ZABCDREMOTELOCATION, on any record. Primary key id. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export.", explained({
    id: [id, "l.ZUNIQUEID"],
    ...attributes("ZABCDREMOTELOCATION", "l", {
      record: "recordId:ZOWNER",
      text: "label url",
      boolean: "isPrimary isPrivate",
      integer: "orderingIndex"
    })
  }, {
    id: "Remote location identifier, AddressBook ZABCDREMOTELOCATION.ZUNIQUEID; the primary key.",
    recordId: "Owning record: ZABCDREMOTELOCATION.ZOWNER resolved to that record's ZUNIQUEID. Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export. NULL when unset or no record matches."
  }), "ZABCDREMOTELOCATION l", ["id"]),
  // vCard lines Contacts kept without understanding them. They have no
  // identifier, so the line itself is part of the key.
  unknownProperties: definition("One row per distinct vCard line that Contacts kept without interpreting it, from the AddressBook table ZABCDUNKNOWNPROPERTY. The native rows have no identifier, so the primary key is (recordId, propertyName, originalLine); the same line stored twice on one record is one row. recordId refers to contacts.id, groups.id or containers.id within this source, or to a record kind this source does not export.", explained({
    recordId: [id, "r.ZUNIQUEID"],
    propertyName: [text, "u.ZPROPERTYNAME"],
    originalLine: [text, "u.ZORIGINALLINE"]
  }, {
    recordId: "Owning record identifier (ZABCDRECORD.ZUNIQUEID of ZABCDUNKNOWNPROPERTY.ZOWNER). Join to contacts.id, groups.id or containers.id within this source; it can name a record kind this source does not export.",
    propertyName: "vCard property name as stored in AddressBook ZABCDUNKNOWNPROPERTY.ZPROPERTYNAME.",
    originalLine: "The original vCard line from AddressBook ZABCDUNKNOWNPROPERTY.ZORIGINALLINE, which stores bytes: exported as Base64 of those bytes, so decoding it recovers the exact line, unless those bytes form a binary property list, which loads as JSON instead. Text the store holds as text passes through unchanged."
  }), "ZABCDUNKNOWNPROPERTY u JOIN ZABCDRECORD r ON r.Z_PK = u.ZOWNER", ["recordId", "propertyName", "originalLine"], { distinct: true }),
  // The address a distribution list (group) uses for each member.
  distributionListConfigs: definition("One row per distribution-list choice in the AddressBook table ZABCDDISTRIBUTIONLISTCONFIG: which of member contactId's email addresses, phone numbers or postal addresses group groupId uses for that member, as set by Contacts' Edit Distribution List (ABGroup setDistributionIdentifier:forProperty:person:, which a live store saves here). A member without a row uses its default value. Primary key (groupId, contactId, propertyName), assumed unique since the store does not enforce it. emailId, phoneId and addressId refer to emailAddresses.id, phoneNumbers.id and postalAddresses.id within this source.", explained({
    groupId: [id, "g.ZUNIQUEID"],
    contactId: [id, "c.ZUNIQUEID"],
    propertyName: [text, "d.ZPROPERTYNAME"],
    emailId: uniqueIdOf("ZABCDEMAILADDRESS", "d.ZEMAIL"),
    phoneId: uniqueIdOf("ZABCDPHONENUMBER", "d.ZPHONE"),
    addressId: uniqueIdOf("ZABCDPOSTALADDRESS", "d.ZADDRESS")
  }, {
    groupId: "Group identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZGROUP); refers to groups.id within this source.",
    contactId: "Member contact identifier (ZABCDRECORD.ZUNIQUEID of ZABCDDISTRIBUTIONLISTCONFIG.ZCONTACT); refers to contacts.id within this source.",
    propertyName: "The contact property the choice is for, as stored in AddressBook ZABCDDISTRIBUTIONLISTCONFIG.ZPROPERTYNAME (Email for an email address choice, as a live store shows); part of the key. Other values are not verified.",
    emailId: "Chosen email address: the record ZABCDDISTRIBUTIONLISTCONFIG.ZEMAIL references, resolved to that ZABCDEMAILADDRESS record's ZUNIQUEID. Join to emailAddresses.id within this source. NULL when unset or no record matches.",
    phoneId: "Chosen phone number: the record ZABCDDISTRIBUTIONLISTCONFIG.ZPHONE references, resolved to that ZABCDPHONENUMBER record's ZUNIQUEID. Join to phoneNumbers.id within this source. NULL when unset or no record matches.",
    addressId: "Chosen postal address: the record ZABCDDISTRIBUTIONLISTCONFIG.ZADDRESS references, resolved to that ZABCDPOSTALADDRESS record's ZUNIQUEID. Join to postalAddresses.id within this source. NULL when unset or no record matches."
  }), "ZABCDDISTRIBUTIONLISTCONFIG d JOIN ZABCDRECORD g ON g.Z_PK = d.ZGROUP JOIN ZABCDRECORD c ON c.Z_PK = d.ZCONTACT", ["groupId", "contactId", "propertyName"]),
  // A contact's photo and thumbnail, each inline or in _EXTERNAL_DATA.
  images: {
    description: "One row per stored contact image, from AddressBook ZABCDRECORD.ZIMAGEDATA (kind image) and ZTHUMBNAILIMAGEDATA (kind thumbnail): at most two rows per contact. Primary key (contactId, kind); contactId refers to contacts.id. byteLength and sha256 are computed from the bytes when extracted; a stored external file that cannot be read fails the extraction instead of producing a row.",
    properties: {
      contactId: {
        ...id,
        description: "Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; refers to contacts.id within this source. Part of the primary key with kind."
      },
      kind: {
        ...text,
        enum: ["image", "thumbnail"],
        description: "Which stored image this row is: image for ZABCDRECORD.ZIMAGEDATA, thumbnail for ZABCDRECORD.ZTHUMBNAILIMAGEDATA. Part of the primary key with contactId."
      },
      storage: {
        ...text,
        enum: ["inline", "external"],
        description: "Where Contacts keeps the bytes in its own store: inline inside the database column, or external in a file under the store's .AddressBook-v22_SUPPORT/_EXTERNAL_DATA directory. It describes the native source, not an exported file."
      },
      externalId: {
        ...nullableText,
        description: "Contacts' storage identifier for external bytes: the file name under .AddressBook-v22_SUPPORT/_EXTERNAL_DATA recorded in the column. NULL when storage is inline. It is not an exported file."
      },
      byteLength: {
        type: "integer",
        minimum: 0,
        description: "Size in bytes of the stored image: the inline bytes after the storage marker, or the external file. Computed by this connector at extraction."
      },
      sha256: {
        ...text,
        description: "Lowercase hexadecimal SHA-256 of the same bytes byteLength counts, computed by this connector at extraction."
      }
    },
    primaryKey: ["contactId", "kind"],
    sql: `SELECT c.ZUNIQUEID AS contactId, c.ZIMAGEDATA AS image, c.ZTHUMBNAILIMAGEDATA AS thumbnail FROM ZABCDRECORD c ${contact.join} WHERE c.ZIMAGEDATA IS NOT NULL OR c.ZTHUMBNAILIMAGEDATA IS NOT NULL`,
    files: true
  }
};
requires("ZABCDRECORD", "ZIMAGEDATA ZTHUMBNAILIMAGEDATA");
requires("ZABCDUNKNOWNPROPERTY", "ZPROPERTYNAME ZORIGINALLINE");
requires("ZABCDDISTRIBUTIONLISTCONFIG", "ZPROPERTYNAME");
var requiredSchema = {
  columns: Object.fromEntries([...required].map(([table, columns]) => [table, [...columns]])),
  entities: [...requiredEntities]
};
var catalog = new Catalog(Object.entries(definitions).map(([name2, definition2]) => new Stream({
  name: name2,
  jsonSchema: {
    type: "object",
    description: `${definition2.description} ${localStores}`,
    properties: definition2.properties,
    required: Object.keys(definition2.properties)
  },
  primaryKey: [...definition2.primaryKey],
  supportedSyncModes: ["full_refresh", "incremental"],
  sourceDefinedCursor: true,
  emitsDeletes: true,
  ..."files" in definition2 && { supportsFileTransfer: true }
})));
function recordFrom(name2, row) {
  const record2 = {};
  for (const [field, schema] of Object.entries(definitions[name2].properties)) {
    const value = row[field] ?? null;
    record2[field] = value === null ? null : schema.type.includes("boolean") ? value !== 0 : value instanceof Uint8Array ? isBinaryPlist(value) ? plistJSON(decodeArchive(value)) : Buffer.from(value).toString("base64") : value;
  }
  return record2;
}

// apps/apple/connectors/dist/sources/apple-contacts/apple-contacts-source.js
var isStreamName = (name2) => Object.hasOwn(definitions, name2);
var imageKey = (contactId, kind) => JSON.stringify([contactId, kind]);
async function sha256(data) {
  const hash = createHash("sha256");
  if (data.storage === "inline")
    hash.update(data.bytes);
  else
    for await (const chunk of createReadStream(data.path))
      hash.update(chunk);
  return hash.digest("hex");
}
var pollIntervalMs = 1e3;
var AppleContactsSource = class extends Source {
  identity;
  catalog = catalog;
  containers = catalog.get("containers");
  groups = catalog.get("groups");
  groupMembers = catalog.get("groupMembers");
  groupSubgroups = catalog.get("groupSubgroups");
  contacts = catalog.get("contacts");
  notes = catalog.get("notes");
  alternateBirthdays = catalog.get("alternateBirthdays");
  phoneNumbers = catalog.get("phoneNumbers");
  emailAddresses = catalog.get("emailAddresses");
  postalAddresses = catalog.get("postalAddresses");
  urlAddresses = catalog.get("urlAddresses");
  socialProfiles = catalog.get("socialProfiles");
  messagingAddresses = catalog.get("messagingAddresses");
  relatedNames = catalog.get("relatedNames");
  contactDates = catalog.get("contactDates");
  calendarUris = catalog.get("calendarUris");
  addressingGrammars = catalog.get("addressingGrammars");
  likenesses = catalog.get("likenesses");
  alertTones = catalog.get("alertTones");
  customPropertyValues = catalog.get("customPropertyValues");
  remoteLocations = catalog.get("remoteLocations");
  unknownProperties = catalog.get("unknownProperties");
  distributionListConfigs = catalog.get("distributionListConfigs");
  images = catalog.get("images");
  directory;
  scope;
  constructor(directory = addressBookDirectory, scope = {}) {
    super();
    this.directory = directory;
    this.scope = scope;
    this.identity = `apple-contacts:${directory}`;
    Object.freeze(this);
  }
  open() {
    return AddressBook.open(this.directory, requiredSchema);
  }
  coverage(_stream) {
    return { ...localAppleStoreCoverage, selection: this.scope };
  }
  async *observe({ streams, signal }) {
    var _stack = [];
    try {
      if (signal.aborted)
        return;
      const version = __using(_stack, new AddressBookVersion(this.directory));
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
  async *extract(configuration, state, _partition, book) {
    var _stack = [];
    try {
      const { stream } = configuration;
      const { name: name2 } = stream;
      if (!isStreamName(name2))
        throw new TypeError(`Contacts has no stream ${name2}`);
      const files = /* @__PURE__ */ new Map();
      const rows = [];
      for (const store of book.stores) {
        const accepts = contactSelection(store, this.scope);
        rows.push(...name2 === "images" ? await this.#images(store, files, accepts) : store.all(definitions[name2].sql).filter((row) => accepts(name2, row)).map((row) => {
          const record2 = recordFrom(name2, row);
          if (name2 === "containers")
            record2.source = store.source;
          return record2;
        }));
      }
      const records = validateRecords(stream, rows, "Contacts");
      const messages = configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
      if (configuration.fileReads.length === 0 || name2 !== "images") {
        yield* messages;
        return;
      }
      const staging = __using(_stack, await mkdtempDisposable(join2(tmpdir(), "elt-contacts-")), true);
      let staged = 0;
      for await (const message of messages) {
        if ("type" in message) {
          yield message;
          continue;
        }
        const data = files.get(imageKey(message.data.contactId, message.data.kind));
        if (data === void 0)
          throw new TypeError("Contacts image record lost its stored data");
        if (data.storage === "external") {
          yield { ...message, file: data.path };
          continue;
        }
        const path = join2(staging.path, String(staged++));
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
  async #images(store, files, accepts) {
    const records = [];
    for (const row of store.all(definitions.images.sql).filter((row2) => accepts("images", row2)))
      for (const kind of ["image", "thumbnail"]) {
        const value = row[kind];
        if (!(value instanceof Uint8Array))
          continue;
        const data = store.storedData(value);
        files.set(imageKey(row.contactId, kind), data);
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
function contactSelection(store, scope) {
  if (scope.collectionIds === void 0)
    return () => true;
  const containers = new Set(store.all(definitions.containers.sql).filter((row) => selected(scope.collectionIds, row.id)).map((row) => row.id));
  const contacts = new Set(store.all(definitions.contacts.sql).filter((row) => containers.has(row.containerId)).map((row) => row.id));
  const groups = new Set(store.all(definitions.groups.sql).filter((row) => containers.has(row.containerId)).map((row) => row.id));
  const records = /* @__PURE__ */ new Set([...containers, ...contacts, ...groups]);
  return (name2, row) => {
    if (name2 === "containers")
      return containers.has(row.id);
    if (name2 === "contacts")
      return contacts.has(row.id);
    if (name2 === "groups")
      return groups.has(row.id);
    return (!("contactId" in row) || contacts.has(row.contactId)) && (!("groupId" in row) || groups.has(row.groupId)) && (!("parentGroupId" in row) || groups.has(row.parentGroupId)) && (!("childGroupId" in row) || groups.has(row.childGroupId)) && (!("recordId" in row) || records.has(row.recordId));
  };
}

// apps/apple/connectors/dist/apps/contacts/contacts-app.mjs
var ContactsApp = class extends AppleApp {
  name = "contacts";
  title = "Contacts";
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
  ContactsApp as default
};
