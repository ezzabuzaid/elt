import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import {
  type PlistValue,
  decodeArchive,
  isDictionary,
} from '@workspace/macos-plist';

// Where macOS keeps this user's Accounts store.
export const accountsStorePath = join(
  homedir(),
  'Library/Accounts/Accounts4.sqlite',
);

// One account in the system Accounts store, as the Accounts framework keeps
// it: Mail, Calendar, Contacts and Notes accounts all live here, often as a
// child of the account the user signed in with (an IMAP account under its
// iCloud or Google account).
export type Account = {
  // ACAccount.identifier; Mail names its account folders after it.
  readonly identifier: string;
  // ACAccountType.identifier, such as com.apple.account.IMAP.
  readonly type: string;
  // The parent account's identifier.
  readonly parent: string | null;
  readonly description: string | null;
  readonly username: string | null;
  readonly active: boolean;
  // Data classes enabled on this account, such as com.apple.Dataclass.Mail.
  readonly enabledDataclasses: readonly string[];
  // The account's properties, decoded from their keyed archives.
  readonly properties: Readonly<Record<string, PlistValue>>;
  // Per data class settings, such as the iCloud mail servers.
  readonly dataclassProperties: Readonly<Record<string, PlistValue>>;
};

export class AccountsUnavailableError extends Error {
  override name = 'AccountsUnavailableError';

  constructor(path: string, cause: unknown) {
    super(
      `The system Accounts store at ${path} cannot be read. Allow the process that runs the export Full Disk Access in System Settings > Privacy & Security.`,
      { cause },
    );
  }
}

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

  read(): Account[] {
    using database = this.#open();
    const properties = accountProperties(database);
    const enabled = enabledDataclasses(database);
    const rows = database
      .prepare(
        `SELECT account.Z_PK AS pk, account.ZIDENTIFIER AS identifier,
                type.ZIDENTIFIER AS type, account.ZPARENTACCOUNT AS parent,
                account.ZACCOUNTDESCRIPTION AS description,
                account.ZUSERNAME AS username, account.ZACTIVE AS active,
                account.ZDATACLASSPROPERTIES AS dataclassProperties
         FROM ZACCOUNT AS account
         JOIN ZACCOUNTTYPE AS type ON type.Z_PK = account.ZACCOUNTTYPE
         ORDER BY account.Z_PK`,
      )
      .all()
      .map(accountRow);
    const identifiers = new Map(rows.map((row) => [row.pk, row.identifier]));
    return rows.map((row) => {
      const dataclassProperties = decoded(row.dataclassProperties);
      return {
        identifier: row.identifier,
        type: row.type,
        parent:
          row.parent === null ? null : (identifiers.get(row.parent) ?? null),
        description: row.description,
        username: row.username,
        active: row.active === 1,
        enabledDataclasses: enabled.get(row.pk) ?? [],
        properties: properties.get(row.pk) ?? {},
        dataclassProperties: isDictionary(dataclassProperties)
          ? dataclassProperties
          : {},
      };
    });
  }

  // A probe whose current value changes with each commit to the store, such
  // as accountsd saving an account.
  version(): AccountsStoreVersion {
    return new AccountsStoreVersion(this.#open());
  }

  #open(): DatabaseSync {
    try {
      return new DatabaseSync(this.#path, { readOnly: true });
    } catch (error) {
      throw new AccountsUnavailableError(this.#path, error);
    }
  }
}

// accountsd commits through a WAL. SQLite's data_version changes on every
// commit by another connection, so polling current sees each one without
// watching files.
export class AccountsStoreVersion implements Disposable {
  readonly #database: DatabaseSync;
  readonly #version: StatementSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
    this.#version = database.prepare('PRAGMA data_version');
  }

  get current(): number {
    return Number(this.#version.get()?.data_version);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

function accountRow(row: Record<string, unknown>): AccountRow {
  const text = (value: unknown) => (typeof value === 'string' ? value : null);
  const identifier = text(row.identifier);
  const type = text(row.type);
  if (identifier === null || type === null)
    throw new TypeError('An Accounts store account has no identifier or type');
  return {
    pk: Number(row.pk),
    identifier,
    type,
    parent: row.parent === null ? null : Number(row.parent),
    description: text(row.description),
    username: text(row.username),
    active: row.active === null ? null : Number(row.active),
    dataclassProperties:
      row.dataclassProperties instanceof Uint8Array
        ? row.dataclassProperties
        : null,
  };
}

function accountProperties(
  database: DatabaseSync,
): Map<number, Record<string, PlistValue>> {
  const byAccount = new Map<number, Record<string, PlistValue>>();
  const rows = database
    .prepare(
      'SELECT ZOWNER AS owner, ZKEY AS key, ZVALUE AS value FROM ZACCOUNTPROPERTY',
    )
    .all();
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
function enabledDataclasses(database: DatabaseSync): Map<number, string[]> {
  const table = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'Z_*ENABLEDDATACLASSES'",
    )
    .get()?.name;
  if (typeof table !== 'string')
    throw new TypeError('The Accounts store has no enabled data class table');
  const columns = database
    .prepare(`SELECT name FROM pragma_table_info('${table}')`)
    .all()
    .map(({ name }) => String(name));
  const account = columns.find((name) => name.endsWith('ENABLEDACCOUNTS'));
  const dataclass = columns.find((name) => name.endsWith('ENABLEDDATACLASSES'));
  if (account === undefined || dataclass === undefined)
    throw new TypeError(`The Accounts store table ${table} has another shape`);
  const names = new Map(
    database
      .prepare('SELECT Z_PK AS pk, ZNAME AS name FROM ZDATACLASS')
      .all()
      .map(({ pk, name }) => [Number(pk), String(decoded(name))]),
  );
  const enabled = new Map<number, string[]>();
  for (const row of database
    .prepare(
      `SELECT "${account}" AS account, "${dataclass}" AS dataclass FROM "${table}"`,
    )
    .all()) {
    const name = names.get(Number(row.dataclass));
    if (name === undefined) continue;
    const account = Number(row.account);
    enabled.set(account, [...(enabled.get(account) ?? []), name]);
  }
  return enabled;
}
