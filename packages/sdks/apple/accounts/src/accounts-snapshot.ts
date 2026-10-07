import {
  type PlistValue,
  decodeArchive,
  isDictionary,
} from '@workspace/codec-plist';
import {
  AppDatabase,
  type AppDatabaseColumns,
} from '@workspace/sdk-apple-app-database';

import { Account } from './account.ts';
import { AccountsSchemaError, AccountsUnavailableError } from './errors.ts';

// A kind of account, such as com.apple.account.IMAP, and the data classes it
// can offer.
export type AccountType = {
  readonly identifier: string;
  readonly description: string | null;
  readonly credentialType: string | null;
  readonly credentialProtectionPolicy: string | null;
  readonly owningBundleId: string | null;
  readonly obsolete: boolean | null;
  readonly supportsAuthentication: boolean | null;
  readonly supportsMultipleAccounts: boolean | null;
  readonly visibility: number | null;
  readonly supportedDataclasses: readonly string[];
  readonly syncableDataclasses: readonly string[];
};

// A kind of data an account syncs, such as com.apple.Dataclass.Mail, and the
// Accounts framework's number for it.
export type Dataclass = {
  readonly name: string;
  readonly enumValue: number | null;
};

// An option key an app passes to request access to a kind of account, such
// as ACFacebookAppIdKey, and the account types it applies to.
export type AccessOptionKey = {
  readonly name: string;
  readonly enumValue: number | null;
  readonly accountTypes: readonly string[];
};

// An app's granted access to one kind of account.
export type Authorization = {
  readonly accountType: string;
  readonly bundleId: string;
  readonly grantedPermissions: string | null;
  readonly options: PlistValue;
};

// When a stored credential for an account and service expires. The
// credential itself lives in the keychain, not here.
export type CredentialItem = {
  readonly accountIdentifier: string;
  readonly serviceName: string;
  readonly expiresAt: Date | null;
  readonly persistent: boolean | null;
};

const accountColumns = {
  ZACCOUNT: [
    'Z_PK',
    'ZIDENTIFIER',
    'ZACCOUNTTYPE',
    'ZPARENTACCOUNT',
    'ZACCOUNTDESCRIPTION',
    'ZUSERNAME',
    'ZACTIVE',
    'ZAUTHENTICATED',
    'ZSUPPORTSAUTHENTICATION',
    'ZVISIBLE',
    'ZWARMINGUP',
    'ZDATE',
    'ZLASTCREDENTIALRENEWALREJECTIONDATE',
    'ZAUTHENTICATIONTYPE',
    'ZCREDENTIALTYPE',
    'ZMODIFICATIONID',
    'ZOWNINGBUNDLEID',
    'ZDATACLASSPROPERTIES',
  ],
  ZACCOUNTTYPE: ['Z_PK', 'ZIDENTIFIER'],
  ZACCOUNTPROPERTY: ['ZOWNER', 'ZKEY', 'ZVALUE'],
  ZDATACLASS: ['Z_PK', 'ZNAME'],
} satisfies AppDatabaseColumns;
const accountTypeColumns = {
  ZACCOUNTTYPE: [
    'Z_PK',
    'ZIDENTIFIER',
    'ZACCOUNTTYPEDESCRIPTION',
    'ZCREDENTIALTYPE',
    'ZCREDENTIALPROTECTIONPOLICY',
    'ZOWNINGBUNDLEID',
    'ZOBSOLETE',
    'ZSUPPORTSAUTHENTICATION',
    'ZSUPPORTSMULTIPLEACCOUNTS',
    'ZVISIBILITY',
  ],
  ZDATACLASS: ['Z_PK', 'ZNAME'],
} satisfies AppDatabaseColumns;
const dataclassColumns = {
  ZDATACLASS: ['ZNAME', 'ZENUMVALUE'],
} satisfies AppDatabaseColumns;
const accessOptionKeyColumns = {
  ZACCESSOPTIONSKEY: ['Z_PK', 'ZNAME', 'ZENUMVALUE'],
  ZACCOUNTTYPE: ['Z_PK', 'ZIDENTIFIER'],
} satisfies AppDatabaseColumns;
const authorizationColumns = {
  ZAUTHORIZATION: [
    'ZACCOUNTTYPE',
    'ZBUNDLEID',
    'ZGRANTEDPERMISSIONS',
    'ZOPTIONS',
  ],
  ZACCOUNTTYPE: ['Z_PK', 'ZIDENTIFIER'],
} satisfies AppDatabaseColumns;
const credentialItemColumns = {
  ZCREDENTIALITEM: [
    'ZACCOUNTIDENTIFIER',
    'ZSERVICENAME',
    'ZEXPIRATIONDATE',
    'ZPERSISTENT',
  ],
} satisfies AppDatabaseColumns;

// Core Data dates are seconds since 2001-01-01. SQLite converts them, so the
// millisecond rounds as SQLite rounds it.
const instant = (column: string) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', ${column} + 978307200, 'unixepoch')`;

// The store as of one moment: everything read through it agrees. Each kind of
// record is read on request and checks only the tables it reads. Hold it only
// while reading: an open read stops accountsd checkpointing its WAL.
export class AccountsSnapshot implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, AccountsUnavailableError);
  }

  accounts(): Account[] {
    this.#require(accountColumns);
    const names = this.#dataclassNames();
    const enabled = this.#links('ENABLEDDATACLASSES', 'ENABLEDACCOUNTS');
    const provisioned = this.#links(
      'PROVISIONEDDATACLASSES',
      'PROVISIONEDACCOUNTS',
    );
    const properties = this.#accountProperties();
    const rows = this.#database
      .all(
        `SELECT account.Z_PK AS pk, account.ZIDENTIFIER AS identifier,
                type.ZIDENTIFIER AS type, account.ZPARENTACCOUNT AS parent,
                account.ZACCOUNTDESCRIPTION AS description,
                account.ZUSERNAME AS username, account.ZACTIVE AS active,
                account.ZAUTHENTICATED AS authenticated,
                account.ZSUPPORTSAUTHENTICATION AS supportsAuthentication,
                account.ZVISIBLE AS visible, account.ZWARMINGUP AS warmingUp,
                ${instant('account.ZDATE')} AS createdAt,
                ${instant('account.ZLASTCREDENTIALRENEWALREJECTIONDATE')}
                  AS lastCredentialRenewalRejectedAt,
                account.ZAUTHENTICATIONTYPE AS authenticationType,
                account.ZCREDENTIALTYPE AS credentialType,
                account.ZMODIFICATIONID AS modificationId,
                account.ZOWNINGBUNDLEID AS owningBundleId,
                account.ZDATACLASSPROPERTIES AS dataclassProperties
         FROM ZACCOUNT AS account
         JOIN ZACCOUNTTYPE AS type ON type.Z_PK = account.ZACCOUNTTYPE
         ORDER BY account.Z_PK`,
      )
      .map((row) => ({
        pk: Number(row.pk),
        identifier: required(row.identifier, 'An account has no identifier'),
        type: required(row.type, 'An account has no type'),
        parent: row.parent === null ? null : Number(row.parent),
        row,
      }));
    const byKey = new Map(rows.map((row) => [row.pk, row]));
    const accounts = new Map<number, Account>();
    // A parent can sort after its child, so each account is built after its
    // parent, once.
    const account = (entry: (typeof rows)[number]): Account => {
      const built = accounts.get(entry.pk);
      if (built !== undefined) return built;
      const { row } = entry;
      const parent =
        entry.parent === null ? undefined : byKey.get(entry.parent);
      const dataclassProperties = decoded(row.dataclassProperties);
      const created = new Account({
        identifier: entry.identifier,
        type: entry.type,
        parent: parent === undefined ? null : account(parent),
        description: string(row.description),
        username: string(row.username),
        active: row.active === 1,
        authenticated: flag(row.authenticated),
        supportsAuthentication: flag(row.supportsAuthentication),
        visible: flag(row.visible),
        warmingUp: flag(row.warmingUp),
        createdAt: date(row.createdAt),
        lastCredentialRenewalRejectedAt: date(
          row.lastCredentialRenewalRejectedAt,
        ),
        authenticationType: string(row.authenticationType),
        credentialType: string(row.credentialType),
        modificationId: string(row.modificationId),
        owningBundleId: string(row.owningBundleId),
        enabledDataclasses: named(enabled.get(entry.pk), names),
        provisionedDataclasses: named(provisioned.get(entry.pk), names),
        properties: properties.get(entry.pk) ?? {},
        dataclassProperties: isDictionary(dataclassProperties)
          ? dataclassProperties
          : {},
      });
      accounts.set(entry.pk, created);
      return created;
    };
    return rows.map(account);
  }

  accountTypes(): AccountType[] {
    this.#require(accountTypeColumns);
    const names = this.#dataclassNames();
    const supported = this.#links('SUPPORTEDDATACLASSES', 'SUPPORTEDTYPES');
    const syncable = this.#links('SYNCABLEDATACLASSES', 'SYNCABLETYPES');
    return this.#database
      .all(
        `SELECT Z_PK AS pk, ZIDENTIFIER AS identifier,
                ZACCOUNTTYPEDESCRIPTION AS description,
                ZCREDENTIALTYPE AS credentialType,
                ZCREDENTIALPROTECTIONPOLICY AS credentialProtectionPolicy,
                ZOWNINGBUNDLEID AS owningBundleId, ZOBSOLETE AS obsolete,
                ZSUPPORTSAUTHENTICATION AS supportsAuthentication,
                ZSUPPORTSMULTIPLEACCOUNTS AS supportsMultipleAccounts,
                ZVISIBILITY AS visibility
         FROM ZACCOUNTTYPE ORDER BY Z_PK`,
      )
      .map((row) => ({
        identifier: required(
          row.identifier,
          'An account type has no identifier',
        ),
        description: string(row.description),
        credentialType: string(row.credentialType),
        credentialProtectionPolicy: string(row.credentialProtectionPolicy),
        owningBundleId: string(row.owningBundleId),
        obsolete: flag(row.obsolete),
        supportsAuthentication: flag(row.supportsAuthentication),
        supportsMultipleAccounts: flag(row.supportsMultipleAccounts),
        visibility: integer(row.visibility),
        supportedDataclasses: named(supported.get(Number(row.pk)), names),
        syncableDataclasses: named(syncable.get(Number(row.pk)), names),
      }));
  }

  dataclasses(): Dataclass[] {
    this.#require(dataclassColumns);
    return this.#database
      .all(
        'SELECT ZNAME AS name, ZENUMVALUE AS enumValue FROM ZDATACLASS ORDER BY Z_PK',
      )
      .map((row) => ({
        name: required(decoded(row.name), 'A data class has no name'),
        enumValue: integer(row.enumValue),
      }));
  }

  accessOptionKeys(): AccessOptionKey[] {
    this.#require(accessOptionKeyColumns);
    const types = this.#accountTypeIdentifiers();
    const owners = this.#links('OWNINGACCOUNTTYPES', 'ACCESSKEYS');
    return this.#database
      .all(
        'SELECT Z_PK AS pk, ZNAME AS name, ZENUMVALUE AS enumValue FROM ZACCESSOPTIONSKEY ORDER BY Z_PK',
      )
      .map((row) => ({
        name: required(row.name, 'An access option key has no name'),
        enumValue: integer(row.enumValue),
        accountTypes: named(owners.get(Number(row.pk)), types),
      }));
  }

  authorizations(): Authorization[] {
    this.#require(authorizationColumns);
    return this.#database
      .all(
        `SELECT type.ZIDENTIFIER AS accountType,
                authorization.ZBUNDLEID AS bundleId,
                authorization.ZGRANTEDPERMISSIONS AS grantedPermissions,
                authorization.ZOPTIONS AS options
         FROM ZAUTHORIZATION AS authorization
         LEFT JOIN ZACCOUNTTYPE AS type
           ON type.Z_PK = authorization.ZACCOUNTTYPE
         ORDER BY authorization.Z_PK`,
      )
      .map((row) => ({
        accountType: required(
          row.accountType,
          'An authorization has no account type',
        ),
        bundleId: required(row.bundleId, 'An authorization has no bundle'),
        grantedPermissions: string(row.grantedPermissions),
        options: decoded(row.options),
      }));
  }

  credentialItems(): CredentialItem[] {
    this.#require(credentialItemColumns);
    return this.#database
      .all(
        `SELECT ZACCOUNTIDENTIFIER AS accountIdentifier,
                ZSERVICENAME AS serviceName,
                ${instant('ZEXPIRATIONDATE')} AS expiresAt,
                ZPERSISTENT AS persistent
         FROM ZCREDENTIALITEM ORDER BY Z_PK`,
      )
      .map((row) => ({
        accountIdentifier: required(
          row.accountIdentifier,
          'A credential item has no account',
        ),
        serviceName: required(
          row.serviceName,
          'A credential item has no service',
        ),
        expiresAt: date(row.expiresAt),
        persistent: flag(row.persistent),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  // Mail reads only accounts, so a table it does not read fails only the
  // reads of that table, and the snapshot stays open for the rest.
  #require(columns: AppDatabaseColumns): void {
    const missing = this.#database.missingColumns(columns);
    if (missing.length > 0)
      throw new AccountsSchemaError(this.#database.path, missing);
  }

  #dataclassNames(): Map<number, string> {
    return new Map(
      this.#database
        .all('SELECT Z_PK AS pk, ZNAME AS name FROM ZDATACLASS')
        .map(({ pk, name }) => [Number(pk), String(decoded(name))]),
    );
  }

  #accountTypeIdentifiers(): Map<number, string> {
    return new Map(
      this.#database
        .all('SELECT Z_PK AS pk, ZIDENTIFIER AS identifier FROM ZACCOUNTTYPE')
        .map(({ pk, identifier }) => [Number(pk), String(identifier)]),
    );
  }

  #accountProperties(): Map<number, Record<string, PlistValue>> {
    const byAccount = new Map<number, Record<string, PlistValue>>();
    for (const { owner, key, value } of this.#database.all(
      'SELECT ZOWNER AS owner, ZKEY AS key, ZVALUE AS value FROM ZACCOUNTPROPERTY',
    )) {
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
  #links(relationship: string, from: string): Map<number, number[]> {
    const table = this.#database.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB ?",
      `Z_*${relationship}`,
    )[0]?.name;
    if (typeof table !== 'string')
      throw new AccountsSchemaError(this.#database.path, [
        `Z_*${relationship}`,
      ]);
    const columns = this.#database
      .all('SELECT name FROM pragma_table_info(?)', table)
      .map(({ name }) => String(name));
    const source = columns.find((name) => name.endsWith(from));
    const target = columns.find((name) => name !== source);
    if (source === undefined || target === undefined || columns.length !== 2)
      throw new AccountsSchemaError(this.#database.path, [
        `${table}.Z_*${from}`,
      ]);
    const links = new Map<number, number[]>();
    for (const row of this.#database.all(
      `SELECT "${source}" AS source, "${target}" AS target FROM "${table}"`,
    )) {
      const key = Number(row.source);
      links.set(key, [...(links.get(key) ?? []), Number(row.target)]);
    }
    return links;
  }
}

function named(
  keys: readonly number[] | undefined,
  names: ReadonlyMap<number, string>,
): string[] {
  return (keys ?? []).flatMap((key) => names.get(key) ?? []);
}

function decoded(value: unknown): PlistValue {
  return value instanceof Uint8Array ? decodeArchive(value) : null;
}

function required(value: unknown, missing: string): string {
  if (typeof value !== 'string') throw new TypeError(missing);
  return value;
}

function string(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function integer(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function flag(value: unknown): boolean | null {
  return value === null ? null : Number(value) === 1;
}

function date(value: unknown): Date | null {
  return typeof value === 'string' ? new Date(value) : null;
}
