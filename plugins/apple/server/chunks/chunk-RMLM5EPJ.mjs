import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  decodeArchive,
  isDictionary
} from "./chunk-2VSN4436.mjs";
import {
  AppDatabase,
  AppDatabaseVersion
} from "./chunk-SDFTRGL6.mjs";

// packages/sdks/apple/accounts/dist/accounts-store.js
import { homedir } from "node:os";
import { join } from "node:path";

// packages/sdks/apple/accounts/dist/account.js
var mailDataclass = "com.apple.Dataclass.Mail";
var authenticationProperties = /* @__PURE__ */ new Set([
  "lastAuthenticationServerResponse",
  "nextLivenessNonce",
  "GKPlayerInternal"
]);
var authenticationKeys = {
  "account-info": ["AuthID"]
};
var Account = class {
  // ACAccount.identifier; Mail names its account folders after it.
  identifier;
  // ACAccountType.identifier, such as com.apple.account.IMAP.
  type;
  parent;
  description;
  username;
  active;
  authenticated;
  supportsAuthentication;
  visible;
  warmingUp;
  createdAt;
  lastCredentialRenewalRejectedAt;
  authenticationType;
  credentialType;
  modificationId;
  // The bundle identifier of the app that owns the account.
  owningBundleId;
  // Data classes turned on for this account, such as com.apple.Dataclass.Mail.
  enabledDataclasses;
  // Data classes the account is set up to offer, on or off.
  provisionedDataclasses;
  // The account's properties, decoded from their keyed archives.
  properties;
  // Per data class settings, such as the iCloud mail servers.
  dataclassProperties;
  constructor(fields) {
    this.identifier = fields.identifier;
    this.type = fields.type;
    this.parent = fields.parent;
    this.description = fields.description;
    this.username = fields.username;
    this.active = fields.active;
    this.authenticated = fields.authenticated;
    this.supportsAuthentication = fields.supportsAuthentication;
    this.visible = fields.visible;
    this.warmingUp = fields.warmingUp;
    this.createdAt = fields.createdAt;
    this.lastCredentialRenewalRejectedAt = fields.lastCredentialRenewalRejectedAt;
    this.authenticationType = fields.authenticationType;
    this.credentialType = fields.credentialType;
    this.modificationId = fields.modificationId;
    this.owningBundleId = fields.owningBundleId;
    this.enabledDataclasses = fields.enabledDataclasses;
    this.provisionedDataclasses = fields.provisionedDataclasses;
    this.properties = fields.properties;
    this.dataclassProperties = fields.dataclassProperties;
  }
  // Its own description, else its parent's, such as iCloud or Google. The
  // SMTP accounts this was matched on had no description of their own, so
  // they take their parent's.
  get name() {
    return this.description ?? this.parent?.description ?? null;
  }
  get fullName() {
    return text(this.properties.ACPropertyFullName) ?? text(this.parent?.properties.ACPropertyFullName);
  }
  get userName() {
    return this.username ?? this.parent?.username ?? null;
  }
  // Its own and its parent's identity address, their aliases, their Apple ID
  // aliases and their iCloud Mail address, in that order and each once: a
  // top-level iCloud account holds the last two itself, a child account
  // through its parent.
  get emailAddresses() {
    return [
      ...new Set([
        this.properties.IdentityEmailAddress,
        this.parent?.properties.IdentityEmailAddress,
        ...aliases(this.properties.EmailAliases),
        ...aliases(this.parent?.properties.EmailAliases),
        ...list(this.properties.appleIDAliases),
        ...list(this.parent?.properties.appleIDAliases),
        mailSettings(this).EmailAddress,
        mailSettings(this.parent).EmailAddress
      ].flatMap((address) => text(address) ?? []))
    ];
  }
  // Its properties without authentication material, which is not the
  // account's settings and not for copying out of the store.
  get propertiesWithoutAuthentication() {
    return Object.fromEntries(Object.entries(this.properties).filter(([key]) => !authenticationProperties.has(key)).map(([key, value]) => {
      const secret = authenticationKeys[key];
      return [
        key,
        secret === void 0 || !isDictionary(value) ? value : Object.fromEntries(Object.entries(value).filter(([inner]) => !secret.includes(inner)))
      ];
    }));
  }
  // Active, with the data class turned on for it or its parent.
  enabledFor(dataclass) {
    return this.active && [this, this.parent].some((owner) => owner?.enabledDataclasses.includes(dataclass) ?? false);
  }
  // The account this one sends through: an SMTP account, or itself for an
  // Exchange account, which sends through its web service.
  get sendingAccountIdentifier() {
    return text(this.properties.SendingAccountIdentifier);
  }
  // Where an IMAP or Exchange account fetches mail: its own server settings,
  // else its parent's Mail settings (iCloud), else its Exchange web service.
  get incomingMailServer() {
    const mail = this.#parentMail();
    const ews = text(this.properties.EWSExternalURL);
    const exchange = ews === null ? null : URL.parse(ews);
    return {
      host: text(this.properties.Hostname) ?? text(mail.imapHostname) ?? exchange?.hostname ?? null,
      port: number(this.properties.PortNumber) ?? number(mail.imapPort),
      usesTls: this.#usesTls(mail.imapRequiresSSL) ?? (exchange === null ? null : exchange.protocol === "https:"),
      userName: this.userName
    };
  }
  // Where an SMTP account sends mail: its own settings, else its parent's
  // Mail settings (iCloud). It signs in with its identity address when it
  // has one.
  get outgoingMailServer() {
    const mail = this.#parentMail();
    return {
      host: text(this.properties.Hostname) ?? text(mail.smtpHostname),
      port: number(this.properties.PortNumber) ?? number(mail.smtpPort),
      usesTls: this.#usesTls(mail.smtpRequiresSSL),
      userName: text(this.properties.IdentityEmailAddress) ?? this.userName
    };
  }
  // SSLEnabled is Mail's Use TLS/SSL setting. SSLIsDirect says only whether
  // TLS starts on connecting or through STARTTLS, so false leaves the
  // question to requiresSsl, the parent's setting that iCloud keeps instead
  // of SSLEnabled.
  #usesTls(requiresSsl) {
    return flag(this.properties.SSLEnabled) ?? (this.properties.SSLIsDirect === true ? true : null) ?? flag(requiresSsl);
  }
  #parentMail() {
    return mailSettings(this.parent);
  }
};
function mailSettings(account) {
  const settings = account?.dataclassProperties[mailDataclass];
  return isDictionary(settings) ? settings : {};
}
function aliases(value) {
  return list(value).flatMap((entry) => isDictionary(entry) ? list(entry.EmailAddresses) : []);
}
function list(value) {
  return Array.isArray(value) ? value : [];
}
function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}
function number(value) {
  return typeof value === "number" ? value : null;
}
function flag(value) {
  return typeof value === "boolean" ? value : null;
}

// packages/sdks/apple/accounts/dist/errors.js
var AccountsUnavailableError = class extends Error {
  name = "AccountsUnavailableError";
  constructor(path, cause) {
    super(`The system Accounts store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`, { cause });
  }
};
var AccountsSchemaError = class extends Error {
  name = "AccountsSchemaError";
  constructor(path, missing) {
    super(`The system Accounts store at ${path} has a layout this reader does not read (missing ${missing.join(", ")}).`);
  }
};

// packages/sdks/apple/accounts/dist/accounts-snapshot.js
var accountColumns = {
  ZACCOUNT: [
    "Z_PK",
    "ZIDENTIFIER",
    "ZACCOUNTTYPE",
    "ZPARENTACCOUNT",
    "ZACCOUNTDESCRIPTION",
    "ZUSERNAME",
    "ZACTIVE",
    "ZAUTHENTICATED",
    "ZSUPPORTSAUTHENTICATION",
    "ZVISIBLE",
    "ZWARMINGUP",
    "ZDATE",
    "ZLASTCREDENTIALRENEWALREJECTIONDATE",
    "ZAUTHENTICATIONTYPE",
    "ZCREDENTIALTYPE",
    "ZMODIFICATIONID",
    "ZOWNINGBUNDLEID",
    "ZDATACLASSPROPERTIES"
  ],
  ZACCOUNTTYPE: ["Z_PK", "ZIDENTIFIER"],
  ZACCOUNTPROPERTY: ["ZOWNER", "ZKEY", "ZVALUE"],
  ZDATACLASS: ["Z_PK", "ZNAME"]
};
var accountTypeColumns = {
  ZACCOUNTTYPE: [
    "Z_PK",
    "ZIDENTIFIER",
    "ZACCOUNTTYPEDESCRIPTION",
    "ZCREDENTIALTYPE",
    "ZCREDENTIALPROTECTIONPOLICY",
    "ZOWNINGBUNDLEID",
    "ZOBSOLETE",
    "ZSUPPORTSAUTHENTICATION",
    "ZSUPPORTSMULTIPLEACCOUNTS",
    "ZVISIBILITY"
  ],
  ZDATACLASS: ["Z_PK", "ZNAME"]
};
var dataclassColumns = {
  ZDATACLASS: ["ZNAME", "ZENUMVALUE"]
};
var accessOptionKeyColumns = {
  ZACCESSOPTIONSKEY: ["Z_PK", "ZNAME", "ZENUMVALUE"],
  ZACCOUNTTYPE: ["Z_PK", "ZIDENTIFIER"]
};
var authorizationColumns = {
  ZAUTHORIZATION: [
    "ZACCOUNTTYPE",
    "ZBUNDLEID",
    "ZGRANTEDPERMISSIONS",
    "ZOPTIONS"
  ],
  ZACCOUNTTYPE: ["Z_PK", "ZIDENTIFIER"]
};
var credentialItemColumns = {
  ZCREDENTIALITEM: [
    "ZACCOUNTIDENTIFIER",
    "ZSERVICENAME",
    "ZEXPIRATIONDATE",
    "ZPERSISTENT"
  ]
};
var instant = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} + 978307200, 'unixepoch')`;
var AccountsSnapshot = class {
  #database;
  constructor(path) {
    this.#database = new AppDatabase(path, AccountsUnavailableError);
  }
  accounts() {
    this.#require(accountColumns);
    const names = this.#dataclassNames();
    const enabled = this.#links("ENABLEDDATACLASSES", "ENABLEDACCOUNTS");
    const provisioned = this.#links("PROVISIONEDDATACLASSES", "PROVISIONEDACCOUNTS");
    const properties = this.#accountProperties();
    const rows = this.#database.all(`SELECT account.Z_PK AS pk, account.ZIDENTIFIER AS identifier,
                type.ZIDENTIFIER AS type, account.ZPARENTACCOUNT AS parent,
                account.ZACCOUNTDESCRIPTION AS description,
                account.ZUSERNAME AS username, account.ZACTIVE AS active,
                account.ZAUTHENTICATED AS authenticated,
                account.ZSUPPORTSAUTHENTICATION AS supportsAuthentication,
                account.ZVISIBLE AS visible, account.ZWARMINGUP AS warmingUp,
                ${instant("account.ZDATE")} AS createdAt,
                ${instant("account.ZLASTCREDENTIALRENEWALREJECTIONDATE")}
                  AS lastCredentialRenewalRejectedAt,
                account.ZAUTHENTICATIONTYPE AS authenticationType,
                account.ZCREDENTIALTYPE AS credentialType,
                account.ZMODIFICATIONID AS modificationId,
                account.ZOWNINGBUNDLEID AS owningBundleId,
                account.ZDATACLASSPROPERTIES AS dataclassProperties
         FROM ZACCOUNT AS account
         JOIN ZACCOUNTTYPE AS type ON type.Z_PK = account.ZACCOUNTTYPE
         ORDER BY account.Z_PK`).map((row) => ({
      pk: Number(row.pk),
      identifier: required(row.identifier, "An account has no identifier"),
      type: required(row.type, "An account has no type"),
      parent: row.parent === null ? null : Number(row.parent),
      row
    }));
    const byKey = new Map(rows.map((row) => [row.pk, row]));
    const accounts = /* @__PURE__ */ new Map();
    const account = (entry) => {
      const built = accounts.get(entry.pk);
      if (built !== void 0)
        return built;
      const { row } = entry;
      const parent = entry.parent === null ? void 0 : byKey.get(entry.parent);
      const dataclassProperties = decoded(row.dataclassProperties);
      const created = new Account({
        identifier: entry.identifier,
        type: entry.type,
        parent: parent === void 0 ? null : account(parent),
        description: string(row.description),
        username: string(row.username),
        active: row.active === 1,
        authenticated: flag2(row.authenticated),
        supportsAuthentication: flag2(row.supportsAuthentication),
        visible: flag2(row.visible),
        warmingUp: flag2(row.warmingUp),
        createdAt: date(row.createdAt),
        lastCredentialRenewalRejectedAt: date(row.lastCredentialRenewalRejectedAt),
        authenticationType: string(row.authenticationType),
        credentialType: string(row.credentialType),
        modificationId: string(row.modificationId),
        owningBundleId: string(row.owningBundleId),
        enabledDataclasses: named(enabled.get(entry.pk), names),
        provisionedDataclasses: named(provisioned.get(entry.pk), names),
        properties: properties.get(entry.pk) ?? {},
        dataclassProperties: isDictionary(dataclassProperties) ? dataclassProperties : {}
      });
      accounts.set(entry.pk, created);
      return created;
    };
    return rows.map(account);
  }
  accountTypes() {
    this.#require(accountTypeColumns);
    const names = this.#dataclassNames();
    const supported = this.#links("SUPPORTEDDATACLASSES", "SUPPORTEDTYPES");
    const syncable = this.#links("SYNCABLEDATACLASSES", "SYNCABLETYPES");
    return this.#database.all(`SELECT Z_PK AS pk, ZIDENTIFIER AS identifier,
                ZACCOUNTTYPEDESCRIPTION AS description,
                ZCREDENTIALTYPE AS credentialType,
                ZCREDENTIALPROTECTIONPOLICY AS credentialProtectionPolicy,
                ZOWNINGBUNDLEID AS owningBundleId, ZOBSOLETE AS obsolete,
                ZSUPPORTSAUTHENTICATION AS supportsAuthentication,
                ZSUPPORTSMULTIPLEACCOUNTS AS supportsMultipleAccounts,
                ZVISIBILITY AS visibility
         FROM ZACCOUNTTYPE ORDER BY Z_PK`).map((row) => ({
      identifier: required(row.identifier, "An account type has no identifier"),
      description: string(row.description),
      credentialType: string(row.credentialType),
      credentialProtectionPolicy: string(row.credentialProtectionPolicy),
      owningBundleId: string(row.owningBundleId),
      obsolete: flag2(row.obsolete),
      supportsAuthentication: flag2(row.supportsAuthentication),
      supportsMultipleAccounts: flag2(row.supportsMultipleAccounts),
      visibility: integer(row.visibility),
      supportedDataclasses: named(supported.get(Number(row.pk)), names),
      syncableDataclasses: named(syncable.get(Number(row.pk)), names)
    }));
  }
  dataclasses() {
    this.#require(dataclassColumns);
    return this.#database.all("SELECT ZNAME AS name, ZENUMVALUE AS enumValue FROM ZDATACLASS ORDER BY Z_PK").map((row) => ({
      name: required(decoded(row.name), "A data class has no name"),
      enumValue: integer(row.enumValue)
    }));
  }
  accessOptionKeys() {
    this.#require(accessOptionKeyColumns);
    const types = this.#accountTypeIdentifiers();
    const owners = this.#links("OWNINGACCOUNTTYPES", "ACCESSKEYS");
    return this.#database.all("SELECT Z_PK AS pk, ZNAME AS name, ZENUMVALUE AS enumValue FROM ZACCESSOPTIONSKEY ORDER BY Z_PK").map((row) => ({
      name: required(row.name, "An access option key has no name"),
      enumValue: integer(row.enumValue),
      accountTypes: named(owners.get(Number(row.pk)), types)
    }));
  }
  authorizations() {
    this.#require(authorizationColumns);
    return this.#database.all(`SELECT type.ZIDENTIFIER AS accountType,
                authorization.ZBUNDLEID AS bundleId,
                authorization.ZGRANTEDPERMISSIONS AS grantedPermissions,
                authorization.ZOPTIONS AS options
         FROM ZAUTHORIZATION AS authorization
         LEFT JOIN ZACCOUNTTYPE AS type
           ON type.Z_PK = authorization.ZACCOUNTTYPE
         ORDER BY authorization.Z_PK`).map((row) => ({
      accountType: required(row.accountType, "An authorization has no account type"),
      bundleId: required(row.bundleId, "An authorization has no bundle"),
      grantedPermissions: string(row.grantedPermissions),
      options: decoded(row.options)
    }));
  }
  credentialItems() {
    this.#require(credentialItemColumns);
    return this.#database.all(`SELECT ZACCOUNTIDENTIFIER AS accountIdentifier,
                ZSERVICENAME AS serviceName,
                ${instant("ZEXPIRATIONDATE")} AS expiresAt,
                ZPERSISTENT AS persistent
         FROM ZCREDENTIALITEM ORDER BY Z_PK`).map((row) => ({
      accountIdentifier: required(row.accountIdentifier, "A credential item has no account"),
      serviceName: required(row.serviceName, "A credential item has no service"),
      expiresAt: date(row.expiresAt),
      persistent: flag2(row.persistent)
    }));
  }
  [Symbol.dispose]() {
    this.#database[Symbol.dispose]();
  }
  // Mail reads only accounts, so a table it does not read fails only the
  // reads of that table, and the snapshot stays open for the rest.
  #require(columns) {
    const missing = this.#database.missingColumns(columns);
    if (missing.length > 0)
      throw new AccountsSchemaError(this.#database.path, missing);
  }
  #dataclassNames() {
    return new Map(this.#database.all("SELECT Z_PK AS pk, ZNAME AS name FROM ZDATACLASS").map(({ pk, name }) => [Number(pk), String(decoded(name))]));
  }
  #accountTypeIdentifiers() {
    return new Map(this.#database.all("SELECT Z_PK AS pk, ZIDENTIFIER AS identifier FROM ZACCOUNTTYPE").map(({ pk, identifier }) => [Number(pk), String(identifier)]));
  }
  #accountProperties() {
    const byAccount = /* @__PURE__ */ new Map();
    for (const { owner, key, value } of this.#database.all("SELECT ZOWNER AS owner, ZKEY AS key, ZVALUE AS value FROM ZACCOUNTPROPERTY")) {
      const account = Number(owner);
      const properties = byAccount.get(account) ?? {};
      properties[String(key)] = decoded(value);
      byAccount.set(account, properties);
    }
    return byAccount;
  }
  // A many-to-many relationship, keyed by its from side. Core Data names the
  // join table and its columns after entity numbers that change between
  // macOS versions (Z_2ENABLEDDATACLASSES today), so the table is found by
  // its name's end, its from column by its own, and the other column is the
  // table's remaining one.
  #links(relationship, from) {
    const table = this.#database.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ?", `Z_*${relationship}`)[0]?.name;
    if (typeof table !== "string")
      throw new AccountsSchemaError(this.#database.path, [
        `Z_*${relationship}`
      ]);
    const columns = this.#database.all("SELECT name FROM pragma_table_info(?)", table).map(({ name }) => String(name));
    const source = columns.find((name) => name.endsWith(from));
    const target = columns.find((name) => name !== source);
    if (source === void 0 || target === void 0 || columns.length !== 2)
      throw new AccountsSchemaError(this.#database.path, [
        `${table}.Z_*${from}`
      ]);
    const links = /* @__PURE__ */ new Map();
    for (const row of this.#database.all(`SELECT "${source}" AS source, "${target}" AS target FROM "${table}"`)) {
      const key = Number(row.source);
      links.set(key, [...links.get(key) ?? [], Number(row.target)]);
    }
    return links;
  }
};
function named(keys, names) {
  return (keys ?? []).flatMap((key) => names.get(key) ?? []);
}
function decoded(value) {
  return value instanceof Uint8Array ? decodeArchive(value) : null;
}
function required(value, missing) {
  if (typeof value !== "string")
    throw new TypeError(missing);
  return value;
}
function string(value) {
  return typeof value === "string" ? value : null;
}
function integer(value) {
  return value === null ? null : Number(value);
}
function flag2(value) {
  return value === null ? null : Number(value) === 1;
}
function date(value) {
  return typeof value === "string" ? new Date(value) : null;
}

// packages/sdks/apple/accounts/dist/accounts-store.js
var accountsStorePath = join(homedir(), "Library/Accounts/Accounts4.sqlite");
var AccountsStore = class {
  #path;
  constructor(path) {
    this.#path = path;
  }
  // The store as of one moment. accountsd commits about once a minute, so
  // what a run reads comes from one snapshot.
  open() {
    return new AccountsSnapshot(this.#path);
  }
  // A probe whose current value changes with each commit to the store, such
  // as accountsd saving an account.
  version() {
    return new AppDatabaseVersion(this.#path, AccountsUnavailableError);
  }
};

export {
  mailDataclass,
  AccountsUnavailableError,
  accountsStorePath,
  AccountsStore
};
