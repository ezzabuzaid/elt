import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  type PlistValue,
  decodeArchive,
  isDictionary,
} from '@workspace/macos-plist';
import {
  AppDatabase,
  AppDatabaseVersion,
} from '@workspace/sdk-apple-app-database';

// Where macOS keeps this user's Accounts store.
export const accountsStorePath = join(
  homedir(),
  'Library/Accounts/Accounts4.sqlite',
);

// Mail's data class. On a parent account (iCloud) its settings hold the mail
// servers the child accounts use.
export const mailDataclass = 'com.apple.Dataclass.Mail';

// Where an account fetches or sends mail. A value the store does not hold is
// null.
export type MailServer = {
  readonly host: string | null;
  readonly port: number | null;
  readonly usesTls: boolean | null;
  readonly userName: string | null;
};

// One account in the system Accounts store, as the Accounts framework keeps
// it: Mail, Calendar, Contacts and Notes accounts all live here, often as a
// child of the account the user signed in with (an IMAP account under its
// iCloud or Google account). The child carries its own server settings; its
// parent carries the name, the user and, for iCloud, the mail servers. Which
// stored key answers each question was matched against Mail scripting on
// macOS 27, with Exchange, iCloud and Google accounts.
export class Account {
  // ACAccount.identifier; Mail names its account folders after it.
  readonly identifier: string;
  // ACAccountType.identifier, such as com.apple.account.IMAP.
  readonly type: string;
  readonly parent: Account | null;
  readonly description: string | null;
  readonly username: string | null;
  readonly active: boolean;
  // Data classes enabled on this account, such as com.apple.Dataclass.Mail.
  readonly enabledDataclasses: readonly string[];
  // The account's properties, decoded from their keyed archives.
  readonly properties: Readonly<Record<string, PlistValue>>;
  // Per data class settings, such as the iCloud mail servers.
  readonly dataclassProperties: Readonly<Record<string, PlistValue>>;

  constructor(fields: {
    readonly identifier: string;
    readonly type: string;
    readonly parent: Account | null;
    readonly description: string | null;
    readonly username: string | null;
    readonly active: boolean;
    readonly enabledDataclasses: readonly string[];
    readonly properties: Readonly<Record<string, PlistValue>>;
    readonly dataclassProperties: Readonly<Record<string, PlistValue>>;
  }) {
    this.identifier = fields.identifier;
    this.type = fields.type;
    this.parent = fields.parent;
    this.description = fields.description;
    this.username = fields.username;
    this.active = fields.active;
    this.enabledDataclasses = fields.enabledDataclasses;
    this.properties = fields.properties;
    this.dataclassProperties = fields.dataclassProperties;
  }

  // Its own description, else its parent's, such as iCloud or Google. The
  // SMTP accounts this was matched on had no description of their own, so
  // they take their parent's.
  get name(): string | null {
    return this.description ?? this.parent?.description ?? null;
  }

  get fullName(): string | null {
    return (
      text(this.properties.ACPropertyFullName) ??
      text(this.parent?.properties.ACPropertyFullName)
    );
  }

  get userName(): string | null {
    return this.username ?? this.parent?.username ?? null;
  }

  // Its own and its parent's identity address, their aliases, the Apple ID
  // aliases and the iCloud Mail address, in that order and each once.
  get emailAddresses(): string[] {
    return [
      ...new Set(
        [
          this.properties.IdentityEmailAddress,
          this.parent?.properties.IdentityEmailAddress,
          ...aliases(this.properties.EmailAliases),
          ...aliases(this.parent?.properties.EmailAliases),
          ...list(this.parent?.properties.appleIDAliases),
          this.#parentMail().EmailAddress,
        ].flatMap((address) => text(address) ?? []),
      ),
    ];
  }

  // Active, with the data class turned on for it or its parent.
  enabledFor(dataclass: string): boolean {
    return (
      this.active &&
      [this, this.parent].some(
        (owner) => owner?.enabledDataclasses.includes(dataclass) ?? false,
      )
    );
  }

  // The account this one sends through: an SMTP account, or itself for an
  // Exchange account, which sends through its web service.
  get sendingAccountIdentifier(): string | null {
    return text(this.properties.SendingAccountIdentifier);
  }

  // Where an IMAP or Exchange account fetches mail: its own server settings,
  // else its parent's Mail settings (iCloud), else its Exchange web service.
  get incomingMailServer(): MailServer {
    const mail = this.#parentMail();
    const ews = text(this.properties.EWSExternalURL);
    const exchange = ews === null ? null : URL.parse(ews);
    return {
      host:
        text(this.properties.Hostname) ??
        text(mail.imapHostname) ??
        exchange?.hostname ??
        null,
      port: number(this.properties.PortNumber) ?? number(mail.imapPort),
      usesTls:
        this.#usesTls(mail.imapRequiresSSL) ??
        (exchange === null ? null : exchange.protocol === 'https:'),
      userName: this.userName,
    };
  }

  // Where an SMTP account sends mail: its own settings, else its parent's
  // Mail settings (iCloud). It signs in with its identity address when it
  // has one.
  get outgoingMailServer(): MailServer {
    const mail = this.#parentMail();
    return {
      host: text(this.properties.Hostname) ?? text(mail.smtpHostname),
      port: number(this.properties.PortNumber) ?? number(mail.smtpPort),
      usesTls: this.#usesTls(mail.smtpRequiresSSL),
      userName: text(this.properties.IdentityEmailAddress) ?? this.userName,
    };
  }

  // SSLEnabled is Mail's Use TLS/SSL setting. SSLIsDirect says only whether
  // TLS starts on connecting or through STARTTLS, so false leaves the
  // question to requiresSsl, the parent's setting that iCloud keeps instead
  // of SSLEnabled.
  #usesTls(requiresSsl: PlistValue | undefined): boolean | null {
    return (
      flag(this.properties.SSLEnabled) ??
      (this.properties.SSLIsDirect === true ? true : null) ??
      flag(requiresSsl)
    );
  }

  #parentMail(): Readonly<Record<string, PlistValue>> {
    const settings = this.parent?.dataclassProperties[mailDataclass];
    return isDictionary(settings) ? settings : {};
  }
}

export class AccountsUnavailableError extends Error {
  override name = 'AccountsUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The system Accounts store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

// Core Data's layout changes between macOS versions; reading one we have not
// verified would misplace accounts and their settings.
export class AccountsSchemaError extends Error {
  override name = 'AccountsSchemaError';

  constructor(path: string, missing: readonly string[]) {
    super(
      `The system Accounts store at ${path} has a layout this reader does not read (missing ${missing.join(', ')}).`,
    );
  }
}

const columns = {
  ZACCOUNT: [
    'Z_PK',
    'ZIDENTIFIER',
    'ZACCOUNTTYPE',
    'ZPARENTACCOUNT',
    'ZACCOUNTDESCRIPTION',
    'ZUSERNAME',
    'ZACTIVE',
    'ZDATACLASSPROPERTIES',
  ],
  ZACCOUNTTYPE: ['Z_PK', 'ZIDENTIFIER'],
  ZACCOUNTPROPERTY: ['ZOWNER', 'ZKEY', 'ZVALUE'],
  ZDATACLASS: ['Z_PK', 'ZNAME'],
};

type AccountRow = {
  readonly pk: number;
  readonly identifier: string;
  readonly type: string;
  readonly parent: number | null;
  readonly description: string | null;
  readonly username: string | null;
  readonly active: number | null;
  readonly dataclassProperties: Uint8Array | null;
};

// The Accounts framework's Core Data store (Accounts4.sqlite), read without
// the framework: the store, not an app's scripting, holds every account.
export class AccountsStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  // Every account as of one moment: accountsd commits about once a minute, so
  // accounts, properties and data classes are read in one snapshot.
  read(): Account[] {
    using database = new AppDatabase(this.#path, AccountsUnavailableError);
    database.requireColumns(columns, AccountsSchemaError);
    const properties = accountProperties(database);
    const enabled = enabledDataclasses(database);
    const rows = database
      .all(
        `SELECT account.Z_PK AS pk, account.ZIDENTIFIER AS identifier,
                type.ZIDENTIFIER AS type, account.ZPARENTACCOUNT AS parent,
                account.ZACCOUNTDESCRIPTION AS description,
                account.ZUSERNAME AS username, account.ZACTIVE AS active,
                account.ZDATACLASSPROPERTIES AS dataclassProperties
         FROM ZACCOUNT AS account
         JOIN ZACCOUNTTYPE AS type ON type.Z_PK = account.ZACCOUNTTYPE
         ORDER BY account.Z_PK`,
      )
      .map(accountRow);
    const byKey = new Map(rows.map((row) => [row.pk, row]));
    const accounts = new Map<number, Account>();
    // A parent can sort after its child, so each account is built after its
    // parent, once.
    const account = (row: AccountRow): Account => {
      const built = accounts.get(row.pk);
      if (built !== undefined) return built;
      const parent = row.parent === null ? undefined : byKey.get(row.parent);
      const dataclassProperties = decoded(row.dataclassProperties);
      const created = new Account({
        identifier: row.identifier,
        type: row.type,
        parent: parent === undefined ? null : account(parent),
        description: row.description,
        username: row.username,
        active: row.active === 1,
        enabledDataclasses: enabled.get(row.pk) ?? [],
        properties: properties.get(row.pk) ?? {},
        dataclassProperties: isDictionary(dataclassProperties)
          ? dataclassProperties
          : {},
      });
      accounts.set(row.pk, created);
      return created;
    };
    return rows.map(account);
  }

  // A probe whose current value changes with each commit to the store, such
  // as accountsd saving an account.
  version(): AppDatabaseVersion {
    return new AppDatabaseVersion(this.#path, AccountsUnavailableError);
  }
}

function accountRow(row: Record<string, unknown>): AccountRow {
  const string = (value: unknown) => (typeof value === 'string' ? value : null);
  const identifier = string(row.identifier);
  const type = string(row.type);
  if (identifier === null || type === null)
    throw new TypeError('An Accounts store account has no identifier or type');
  return {
    pk: Number(row.pk),
    identifier,
    type,
    parent: row.parent === null ? null : Number(row.parent),
    description: string(row.description),
    username: string(row.username),
    active: row.active === null ? null : Number(row.active),
    dataclassProperties:
      row.dataclassProperties instanceof Uint8Array
        ? row.dataclassProperties
        : null,
  };
}

function accountProperties(
  database: AppDatabase,
): Map<number, Record<string, PlistValue>> {
  const byAccount = new Map<number, Record<string, PlistValue>>();
  const rows = database.all(
    'SELECT ZOWNER AS owner, ZKEY AS key, ZVALUE AS value FROM ZACCOUNTPROPERTY',
  );
  for (const { owner, key, value } of rows) {
    const account = Number(owner);
    const properties = byAccount.get(account) ?? {};
    properties[String(key)] = decoded(value);
    byAccount.set(account, properties);
  }
  return byAccount;
}

function decoded(value: unknown): PlistValue {
  return value instanceof Uint8Array ? decodeArchive(value) : null;
}

// Core Data names the join table and its columns after entity numbers that
// can change between macOS versions (Z_2ENABLEDDATACLASSES today), so the
// table is found by its shape.
function enabledDataclasses(database: AppDatabase): Map<number, string[]> {
  const table = database.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Z_*ENABLEDDATACLASSES'",
  )[0]?.name;
  if (typeof table !== 'string')
    throw new AccountsSchemaError(database.path, ['Z_*ENABLEDDATACLASSES']);
  const names = database
    .all('SELECT name FROM pragma_table_info(?)', table)
    .map(({ name }) => String(name));
  const account = names.find((name) => name.endsWith('ENABLEDACCOUNTS'));
  const dataclass = names.find((name) => name.endsWith('ENABLEDDATACLASSES'));
  if (account === undefined || dataclass === undefined)
    throw new AccountsSchemaError(database.path, [
      `${table}.Z_*ENABLEDACCOUNTS`,
      `${table}.Z_*ENABLEDDATACLASSES`,
    ]);
  const dataclasses = new Map(
    database
      .all('SELECT Z_PK AS pk, ZNAME AS name FROM ZDATACLASS')
      .map(({ pk, name }) => [Number(pk), String(decoded(name))]),
  );
  const enabled = new Map<number, string[]>();
  for (const row of database.all(
    `SELECT "${account}" AS account, "${dataclass}" AS dataclass FROM "${table}"`,
  )) {
    const name = dataclasses.get(Number(row.dataclass));
    if (name === undefined) continue;
    const account = Number(row.account);
    enabled.set(account, [...(enabled.get(account) ?? []), name]);
  }
  return enabled;
}

// Exchange and Google aliases: entries of {DisplayName, IsEnabled,
// EmailAddresses, IsPrimary}.
function aliases(value: PlistValue | undefined): PlistValue[] {
  return list(value).flatMap((entry) =>
    isDictionary(entry) ? list(entry.EmailAddresses) : [],
  );
}

function list(value: PlistValue | undefined): PlistValue[] {
  return Array.isArray(value) ? value : [];
}

function text(value: PlistValue | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function number(value: PlistValue | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function flag(value: PlistValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
