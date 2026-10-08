import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
import {
  AccountsStore,
  accountsStorePath
} from "../../chunks/chunk-Y77BP7PN.mjs";
import {
  plistJSON
} from "../../chunks/chunk-GXPN73JS.mjs";
import {
  localAppleStoreCoverage
} from "../../chunks/chunk-BRJ4TKR5.mjs";
import "../../chunks/chunk-SDFTRGL6.mjs";
import {
  eventKitFields
} from "../../chunks/chunk-YUEL2AIL.mjs";
import {
  AppleConnector
} from "../../chunks/chunk-JBAER3C2.mjs";
import {
  Catalog,
  Source,
  Stream,
  diffSnapshot,
  validateRecords
} from "../../chunks/chunk-6A6J3LDP.mjs";
import {
  __callDispose,
  __using
} from "../../chunks/chunk-ZGXE7NZW.mjs";

// packages/sources/apple/accounts/dist/apple-accounts-source.js
import { setInterval } from "node:timers/promises";

// packages/sources/apple/accounts/dist/accounts-scan.js
var AccountsScan = class {
  #snapshot;
  #accounts;
  #accountTypes;
  #dataclasses;
  #accessOptionKeys;
  #authorizations;
  #credentialItems;
  constructor(snapshot) {
    this.#snapshot = snapshot;
  }
  get accounts() {
    this.#accounts ??= this.#snapshot.accounts();
    return this.#accounts;
  }
  get accountTypes() {
    this.#accountTypes ??= this.#snapshot.accountTypes();
    return this.#accountTypes;
  }
  get dataclasses() {
    this.#dataclasses ??= this.#snapshot.dataclasses();
    return this.#dataclasses;
  }
  get accessOptionKeys() {
    this.#accessOptionKeys ??= this.#snapshot.accessOptionKeys();
    return this.#accessOptionKeys;
  }
  get authorizations() {
    this.#authorizations ??= this.#snapshot.authorizations();
    return this.#authorizations;
  }
  get credentialItems() {
    this.#credentialItems ??= this.#snapshot.credentialItems();
    return this.#credentialItems;
  }
  async [Symbol.asyncDispose]() {
    this.#snapshot[Symbol.dispose]();
  }
};

// packages/sources/apple/accounts/dist/apple-accounts-stream.js
var accountsFields = {
  ...eventKitFields,
  nullableId: { type: ["string", "null"], minLength: 1 },
  nullableBoolean: { type: ["boolean", "null"] },
  nullableInteger: { type: ["integer", "null"] },
  strings: { type: "array", items: { type: "string" } }
};
var AppleAccountsStream = class {
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
  read(scan) {
    return validateRecords(this, this.rows(scan).flatMap((row) => this.records(row)), "Accounts");
  }
};

// packages/sources/apple/accounts/dist/streams/access-option-keys-stream.js
var { id, nullableInteger, strings } = accountsFields;
var properties = {
  name: {
    ...id,
    description: "Option key name, such as ACFacebookAppIdKey; the primary key."
  },
  enumValue: {
    ...nullableInteger,
    description: "The Accounts framework's number for the key as stored; NULL when it holds none."
  },
  accountTypes: {
    ...strings,
    description: "Account types the key applies to, each an accountTypes.id within this source; empty when none."
  }
};
var AccessOptionKeysStream = class extends AppleAccountsStream {
  name = "accessOptionKeys";
  primaryKey = ["name"];
  jsonSchema = {
    type: "object",
    description: "One record per option key an app passes when it asks for access to a kind of account, such as a Facebook app identifier. Primary key name.",
    properties,
    required: Object.keys(properties)
  };
  rows(scan) {
    return scan.accessOptionKeys;
  }
  records(key) {
    return [
      {
        name: key.name,
        enumValue: key.enumValue,
        accountTypes: [...key.accountTypes]
      }
    ];
  }
};

// packages/sources/apple/accounts/dist/streams/account-dataclasses-stream.js
var { id: id2, boolean } = accountsFields;
var properties2 = {
  accountId: {
    ...id2,
    description: "The account; refers to accounts.id within this source."
  },
  dataclass: {
    ...id2,
    description: "Data class name, such as com.apple.Dataclass.Mail; refers to dataclasses.name within this source."
  },
  enabled: {
    ...boolean,
    description: "Whether the data class is turned on for this account. A child account, such as IMAP under iCloud, can rely on its parent having it on."
  },
  provisioned: {
    ...boolean,
    description: "Whether the account is set up to offer the data class, on or off."
  }
};
var AccountDataclassesStream = class extends AppleAccountsStream {
  name = "accountDataclasses";
  primaryKey = ["accountId", "dataclass"];
  jsonSchema = {
    type: "object",
    description: "One record per data class an account offers or has turned on: what it syncs, such as mail, calendars or contacts. Primary key (accountId, dataclass).",
    properties: properties2,
    required: Object.keys(properties2)
  };
  rows(scan) {
    return scan.accounts;
  }
  records(account) {
    return [
      .../* @__PURE__ */ new Set([
        ...account.provisionedDataclasses,
        ...account.enabledDataclasses
      ])
    ].map((dataclass) => ({
      accountId: account.identifier,
      dataclass,
      enabled: account.enabledDataclasses.includes(dataclass),
      provisioned: account.provisionedDataclasses.includes(dataclass)
    }));
  }
};

// packages/sources/apple/accounts/dist/streams/account-properties-stream.js
var { id: id3, text } = accountsFields;
var properties3 = {
  accountId: {
    ...id3,
    description: "The account the property belongs to; refers to accounts.id within this source."
  },
  key: {
    ...id3,
    description: "Property name as stored, such as Hostname, IdentityEmailAddress or appleIDAliases."
  },
  value: {
    ...text,
    description: "The property value as JSON, decoded from its keyed archive: bytes as base64, dates as ISO 8601, large integers as strings. Kept as data without interpretation."
  }
};
var AccountPropertiesStream = class extends AppleAccountsStream {
  name = "accountProperties";
  primaryKey = ["accountId", "key"];
  jsonSchema = {
    type: "object",
    description: "One record per property of an account in the system Accounts store: server settings, aliases, iCloud service flags and other values apps keep on the account. Primary key (accountId, key). Authentication material is not copied: the iTunes Store's encrypted last sign-in response (lastAuthenticationServerResponse), the Apple ID's next liveness nonce (nextLivenessNonce) and Game Center's opaque player record (GKPlayerInternal) are left out, and so is AuthID inside account-info. Passwords are not in this store.",
    properties: properties3,
    required: Object.keys(properties3)
  };
  rows(scan) {
    return scan.accounts;
  }
  records(account) {
    return Object.entries(account.propertiesWithoutAuthentication).map(([key, value]) => ({
      accountId: account.identifier,
      key,
      value: plistJSON(value)
    }));
  }
};

// packages/sources/apple/accounts/dist/streams/account-types-stream.js
var { id: id4, nullableText, nullableBoolean, nullableInteger: nullableInteger2, strings: strings2 } = accountsFields;
var stored = (what) => `${what} as the Accounts framework stores it; NULL when it holds none.`;
var properties4 = {
  id: {
    ...id4,
    description: "Account type identifier, such as com.apple.account.IMAP; the primary key. accounts.type and accessOptionKeys.accountTypes refer to it within this source."
  },
  description: {
    ...nullableText,
    description: stored("The type description, such as IMAP")
  },
  credentialType: {
    ...nullableText,
    description: stored("The credential type its accounts use")
  },
  credentialProtectionPolicy: {
    ...nullableText,
    description: stored("The credential protection policy")
  },
  owningBundleId: {
    ...nullableText,
    description: stored("The bundle identifier of the app that owns the type")
  },
  obsolete: {
    ...nullableBoolean,
    description: stored("Whether the type is obsolete")
  },
  supportsAuthentication: {
    ...nullableBoolean,
    description: stored("Whether its accounts sign in")
  },
  supportsMultipleAccounts: {
    ...nullableBoolean,
    description: stored("Whether one Mac can hold several accounts of it")
  },
  visibility: {
    ...nullableInteger2,
    description: stored("The visibility value")
  },
  supportedDataclasses: {
    ...strings2,
    description: "Data classes its accounts can offer, each a dataclasses.name within this source; empty when none."
  },
  syncableDataclasses: {
    ...strings2,
    description: "Data classes its accounts can sync, each a dataclasses.name within this source; empty when none."
  }
};
var AccountTypesStream = class extends AppleAccountsStream {
  name = "accountTypes";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per kind of account the Accounts framework knows on this Mac, whether or not an account of it exists. Primary key id.",
    properties: properties4,
    required: Object.keys(properties4)
  };
  rows(scan) {
    return scan.accountTypes;
  }
  records(type) {
    return [
      {
        id: type.identifier,
        description: type.description,
        credentialType: type.credentialType,
        credentialProtectionPolicy: type.credentialProtectionPolicy,
        owningBundleId: type.owningBundleId,
        obsolete: type.obsolete,
        supportsAuthentication: type.supportsAuthentication,
        supportsMultipleAccounts: type.supportsMultipleAccounts,
        visibility: type.visibility,
        supportedDataclasses: [...type.supportedDataclasses],
        syncableDataclasses: [...type.syncableDataclasses]
      }
    ];
  }
};

// packages/sources/apple/accounts/dist/streams/accounts-stream.js
var { id: id5, nullableId, nullableText: nullableText2, text: text2, boolean: boolean2, nullableBoolean: nullableBoolean2, nullableTimestamp, strings: strings3 } = accountsFields;
var stored2 = (what) => `${what} as the Accounts framework stores it; NULL when it holds none.`;
var properties5 = {
  id: {
    ...id5,
    description: "Account identifier (ACAccount.identifier); the primary key. parentId, accountProperties.accountId and accountDataclasses.accountId refer to it within this source. Mail names its account folders and the hosts of its mailbox URLs after it."
  },
  type: {
    ...id5,
    description: "Account type identifier, such as com.apple.account.IMAP; refers to accountTypes.id within this source."
  },
  parentId: {
    ...nullableId,
    description: "The account this one belongs to, such as an IMAP or SMTP account under its iCloud or Google account; refers to id within this source. NULL for a top-level account."
  },
  description: {
    ...nullableText2,
    description: stored2("The account description")
  },
  name: {
    ...nullableText2,
    description: "The account's description, else its parent account's, such as iCloud or Google: the name the account appears under. NULL when neither has one."
  },
  username: {
    ...nullableText2,
    description: `${stored2("The user name on this account")} A child account often leaves it to its parent.`
  },
  fullName: {
    ...nullableText2,
    description: "The account's full name property, else its parent's; NULL when neither has one."
  },
  emailAddresses: {
    ...strings3,
    description: "Its own and its parent account's identity address and aliases, the Apple ID aliases and the iCloud Mail address, in that order and each once; empty when it has none."
  },
  active: { ...boolean2, description: "Whether the account is turned on." },
  authenticated: {
    ...nullableBoolean2,
    description: stored2("Whether the account is signed in")
  },
  supportsAuthentication: {
    ...nullableBoolean2,
    description: stored2("Whether the account signs in at all")
  },
  visible: {
    ...nullableBoolean2,
    description: stored2("Whether the account shows in System Settings")
  },
  warmingUp: {
    ...nullableBoolean2,
    description: stored2("Whether the account is still being set up")
  },
  createdAt: {
    ...nullableTimestamp,
    description: "When the account was added to this Mac (ZACCOUNT.ZDATE, Core Data seconds since 2001-01-01, rounded to the millisecond); NULL when not recorded."
  },
  lastCredentialRenewalRejectedAt: {
    ...nullableTimestamp,
    description: "When renewing its credential was last refused; NULL when never recorded."
  },
  authenticationType: {
    ...nullableText2,
    description: stored2("The authentication type")
  },
  credentialType: {
    ...nullableText2,
    description: stored2("The credential type")
  },
  modificationId: {
    ...nullableText2,
    description: stored2("The modification identifier")
  },
  owningBundleId: {
    ...nullableText2,
    description: stored2("The bundle identifier of the app that owns the account")
  },
  dataclassProperties: {
    ...text2,
    description: "JSON object of per data class settings, keyed by data class name, such as iCloud's Mail servers and service URLs; {} when none. Bytes are base64, dates ISO 8601, large integers strings. Kept as data without interpretation."
  }
};
var AccountsStream = class extends AppleAccountsStream {
  name = "accounts";
  primaryKey = ["id"];
  jsonSchema = {
    type: "object",
    description: "One record per account in this Mac's system Accounts store (~/Library/Accounts/Accounts4.sqlite): the accounts Mail, Calendar, Contacts, Notes and other apps sync through, often as children of the account the user signed in with. Primary key id. Read without the Accounts framework or any app's scripting.",
    properties: properties5,
    required: Object.keys(properties5)
  };
  rows(scan) {
    return scan.accounts;
  }
  records(account) {
    return [
      {
        id: account.identifier,
        type: account.type,
        parentId: account.parent?.identifier ?? null,
        description: account.description,
        name: account.name,
        username: account.username,
        fullName: account.fullName,
        emailAddresses: account.emailAddresses,
        active: account.active,
        authenticated: account.authenticated,
        supportsAuthentication: account.supportsAuthentication,
        visible: account.visible,
        warmingUp: account.warmingUp,
        createdAt: account.createdAt?.toISOString() ?? null,
        lastCredentialRenewalRejectedAt: account.lastCredentialRenewalRejectedAt?.toISOString() ?? null,
        authenticationType: account.authenticationType,
        credentialType: account.credentialType,
        modificationId: account.modificationId,
        owningBundleId: account.owningBundleId,
        dataclassProperties: plistJSON(account.dataclassProperties)
      }
    ];
  }
};

// packages/sources/apple/accounts/dist/streams/authorizations-stream.js
var { id: id6, nullableText: nullableText3 } = accountsFields;
var properties6 = {
  accountType: {
    ...id6,
    description: "The kind of account access was granted to; refers to accountTypes.id within this source."
  },
  bundleId: {
    ...id6,
    description: "Bundle identifier of the app granted access."
  },
  grantedPermissions: {
    ...nullableText3,
    description: "The permissions granted, as the Accounts framework stores them; NULL when it holds none."
  },
  options: {
    ...nullableText3,
    description: "The access options as JSON, decoded from their keyed archive; NULL when none are stored. Kept as data without interpretation."
  }
};
var AuthorizationsStream = class extends AppleAccountsStream {
  name = "authorizations";
  primaryKey = ["accountType", "bundleId"];
  jsonSchema = {
    type: "object",
    description: "One record per app granted access to a kind of account through the Accounts framework. Primary key (accountType, bundleId).",
    properties: properties6,
    required: Object.keys(properties6)
  };
  rows(scan) {
    return scan.authorizations;
  }
  records(authorization) {
    return [
      {
        accountType: authorization.accountType,
        bundleId: authorization.bundleId,
        grantedPermissions: authorization.grantedPermissions,
        options: authorization.options === null ? null : plistJSON(authorization.options)
      }
    ];
  }
};

// packages/sources/apple/accounts/dist/streams/credential-items-stream.js
var { id: id7, nullableBoolean: nullableBoolean3, nullableTimestamp: nullableTimestamp2 } = accountsFields;
var properties7 = {
  accountId: {
    ...id7,
    description: "Identifier of the account the credential belongs to, as stored; matches accounts.id within this source while that account exists."
  },
  serviceName: {
    ...id7,
    description: "The service the credential is for, as stored."
  },
  expiresAt: {
    ...nullableTimestamp2,
    description: "When the credential expires, from Core Data seconds since 2001-01-01 rounded to the millisecond; NULL when not recorded."
  },
  persistent: {
    ...nullableBoolean3,
    description: "Whether the credential is kept, as stored; NULL when it holds none."
  }
};
var CredentialItemsStream = class extends AppleAccountsStream {
  name = "credentialItems";
  primaryKey = ["accountId", "serviceName"];
  jsonSchema = {
    type: "object",
    description: "One record per stored credential the Accounts framework tracks: when it expires, not the credential, which lives in the keychain and is not read. Primary key (accountId, serviceName).",
    properties: properties7,
    required: Object.keys(properties7)
  };
  rows(scan) {
    return scan.credentialItems;
  }
  records(item) {
    return [
      {
        accountId: item.accountIdentifier,
        serviceName: item.serviceName,
        expiresAt: item.expiresAt?.toISOString() ?? null,
        persistent: item.persistent
      }
    ];
  }
};

// packages/sources/apple/accounts/dist/streams/dataclasses-stream.js
var { id: id8, nullableInteger: nullableInteger3 } = accountsFields;
var properties8 = {
  name: {
    ...id8,
    description: "Data class name, such as com.apple.Dataclass.Mail; the primary key. accountDataclasses.dataclass and the accountTypes data class lists refer to it within this source."
  },
  enumValue: {
    ...nullableInteger3,
    description: "The Accounts framework's number for the data class as stored; several data classes can share one. NULL when it holds none."
  }
};
var DataclassesStream = class extends AppleAccountsStream {
  name = "dataclasses";
  primaryKey = ["name"];
  jsonSchema = {
    type: "object",
    description: "One record per kind of data the Accounts framework knows accounts can sync, such as mail, calendars or contacts. Primary key name.",
    properties: properties8,
    required: Object.keys(properties8)
  };
  rows(scan) {
    return scan.dataclasses;
  }
  records(dataclass) {
    return [{ name: dataclass.name, enumValue: dataclass.enumValue }];
  }
};

// packages/sources/apple/accounts/dist/apple-accounts-source.js
var readers = {
  accounts: new AccountsStream(),
  accountProperties: new AccountPropertiesStream(),
  accountDataclasses: new AccountDataclassesStream(),
  accountTypes: new AccountTypesStream(),
  dataclasses: new DataclassesStream(),
  accessOptionKeys: new AccessOptionKeysStream(),
  authorizations: new AuthorizationsStream(),
  credentialItems: new CredentialItemsStream()
};
var catalog = new Catalog(Object.values(readers).map((reader) => reader.describe()));
var readersByName = new Map(Object.values(readers).map((reader) => [reader.name, reader]));
var pollIntervalMs = 1e3;
var AppleAccountsSource = class extends Source {
  identity;
  catalog = catalog;
  accounts = readers.accounts.describe();
  accountProperties = readers.accountProperties.describe();
  accountDataclasses = readers.accountDataclasses.describe();
  accountTypes = readers.accountTypes.describe();
  dataclasses = readers.dataclasses.describe();
  accessOptionKeys = readers.accessOptionKeys.describe();
  authorizations = readers.authorizations.describe();
  credentialItems = readers.credentialItems.describe();
  path;
  #store;
  constructor({ path = accountsStorePath } = {}) {
    super();
    this.path = path;
    this.#store = new AccountsStore(path);
    this.identity = `apple-accounts:${path}`;
    Object.freeze(this);
  }
  async open() {
    return new AccountsScan(this.#store.open());
  }
  coverage(_stream) {
    return localAppleStoreCoverage;
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
    const { stream } = configuration;
    const reader = readersByName.get(stream.name);
    if (reader === void 0)
      throw new Error(`Apple Accounts has no stream ${stream.name}`);
    const records = reader.read(scan);
    yield* configuration.syncMode === "incremental" ? diffSnapshot(stream, records, state) : records.map((data) => ({ stream: stream.name, data }));
  }
};

// packages/connectors/apple/accounts/dist/accounts-connector.js
var AccountsConnector = class extends AppleConnector {
  datedBy = null;
  fullDiskAccess = true;
  // One small store of every account on this Mac; everything is imported.
  choices = [];
  // Reading the accounts opens the protected Accounts store.
  probe = "accounts";
  unscoped = [];
  storeCopies = [];
  access() {
    return "No app needs to be open: macOS keeps every account its apps sync through in one store.";
  }
  source() {
    return new AppleAccountsSource();
  }
};
export {
  AccountsConnector as default
};
