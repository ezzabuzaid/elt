import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  AccountsStore,
  AccountsUnavailableError,
  accountsStorePath,
} from './index.ts';

type Archivable =
  | string
  | number
  | boolean
  | readonly Archivable[]
  | { readonly [key: string]: Archivable };

// A synthetic Accounts4.sqlite with the Core Data tables the Accounts
// framework writes, its values stored as real NSKeyedArchiver archives.
class ScratchAccountsStore implements AsyncDisposable {
  readonly path: string;
  readonly #directory: AsyncDisposable & { readonly path: string };
  readonly #database: DatabaseSync;

  private constructor(directory: AsyncDisposable & { readonly path: string }) {
    this.#directory = directory;
    this.path = join(directory.path, 'Accounts4.sqlite');
    this.#database = new DatabaseSync(this.path);
    this.#database.exec(`
      CREATE TABLE ZACCOUNTTYPE (Z_PK INTEGER PRIMARY KEY, ZIDENTIFIER VARCHAR);
      CREATE TABLE ZACCOUNT (Z_PK INTEGER PRIMARY KEY, ZACTIVE INTEGER, ZACCOUNTTYPE INTEGER,
        ZPARENTACCOUNT INTEGER, ZACCOUNTDESCRIPTION VARCHAR, ZIDENTIFIER VARCHAR,
        ZUSERNAME VARCHAR, ZDATACLASSPROPERTIES BLOB);
      CREATE TABLE ZACCOUNTPROPERTY (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZKEY VARCHAR, ZVALUE BLOB);
      CREATE TABLE ZDATACLASS (Z_PK INTEGER PRIMARY KEY, ZNAME BLOB);
      CREATE TABLE Z_2ENABLEDDATACLASSES (Z_2ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER);
    `);
  }

  static async create(): Promise<ScratchAccountsStore> {
    return new ScratchAccountsStore(
      await mkdtempDisposable(join(tmpdir(), 'accounts-store-')),
    );
  }

  async account(account: {
    readonly pk: number;
    readonly identifier: string;
    readonly type: string;
    readonly parent?: number;
    readonly description?: string;
    readonly username?: string;
    readonly active?: boolean;
    readonly enabled?: readonly string[];
    readonly properties?: { readonly [key: string]: Archivable };
    readonly dataclassProperties?: { readonly [key: string]: Archivable };
  }): Promise<void> {
    const type = this.#row(
      'SELECT Z_PK FROM ZACCOUNTTYPE WHERE ZIDENTIFIER = ?',
      'INSERT INTO ZACCOUNTTYPE (ZIDENTIFIER) VALUES (?)',
      account.type,
    );
    this.#database
      .prepare(
        `INSERT INTO ZACCOUNT (Z_PK, ZACTIVE, ZACCOUNTTYPE, ZPARENTACCOUNT,
           ZACCOUNTDESCRIPTION, ZIDENTIFIER, ZUSERNAME, ZDATACLASSPROPERTIES)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.pk,
        account.active === false ? 0 : 1,
        type,
        account.parent ?? null,
        account.description ?? null,
        account.identifier,
        account.username ?? null,
        account.dataclassProperties === undefined
          ? null
          : await this.#archive(account.dataclassProperties),
      );
    for (const [key, value] of Object.entries(account.properties ?? {}))
      this.#database
        .prepare(
          'INSERT INTO ZACCOUNTPROPERTY (ZOWNER, ZKEY, ZVALUE) VALUES (?, ?, ?)',
        )
        .run(account.pk, key, await this.#archive(value));
    for (const name of account.enabled ?? []) {
      const dataclass = await this.#dataclass(name);
      this.#database
        .prepare('INSERT INTO Z_2ENABLEDDATACLASSES VALUES (?, ?)')
        .run(account.pk, dataclass);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#database.close();
    await this.#directory[Symbol.asyncDispose]();
  }

  #row(select: string, insert: string, value: string): number {
    const found = this.#database.prepare(select).get(value)?.Z_PK;
    if (found !== undefined) return Number(found);
    return Number(this.#database.prepare(insert).run(value).lastInsertRowid);
  }

  async #dataclass(name: string): Promise<number> {
    const archived = await this.#archive(name);
    for (const { Z_PK, ZNAME } of this.#database
      .prepare('SELECT Z_PK, ZNAME FROM ZDATACLASS')
      .all())
      if (Buffer.from(Object(ZNAME)).equals(archived)) return Number(Z_PK);
    return Number(
      this.#database
        .prepare('INSERT INTO ZDATACLASS (ZNAME) VALUES (?)')
        .run(archived).lastInsertRowid,
    );
  }

  // Writes value as an NSKeyedArchiver XML plist and lets plutil turn it into
  // the binary archive the Accounts framework stores.
  async #archive(value: Archivable): Promise<Buffer> {
    const objects: string[] = ['<string>$null</string>'];
    const classes = new Map<string, number>();
    const uid = (index: number) =>
      `<dict><key>CF$UID</key><integer>${index}</integer></dict>`;
    const escape = (text: string) =>
      text.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    const classOf = (name: string) => {
      const known = classes.get(name);
      if (known !== undefined) return known;
      objects.push(
        `<dict><key>$classname</key><string>${name}</string><key>$classes</key><array><string>${name}</string><string>NSObject</string></array></dict>`,
      );
      classes.set(name, objects.length - 1);
      return objects.length - 1;
    };
    const add = (item: Archivable): number => {
      const index = objects.push('') - 1;
      if (typeof item === 'string')
        objects[index] = `<string>${escape(item)}</string>`;
      else if (typeof item === 'boolean')
        objects[index] = item ? '<true/>' : '<false/>';
      else if (typeof item === 'number')
        objects[index] = Number.isInteger(item)
          ? `<integer>${item}</integer>`
          : `<real>${item}</real>`;
      else if (Array.isArray(item)) {
        const members = item.map(add);
        objects[index] =
          `<dict><key>NS.objects</key><array>${members.map(uid).join('')}</array><key>$class</key>${uid(classOf('NSArray'))}</dict>`;
      } else {
        const entries = Object.entries(item);
        const keys = entries.map(([key]) => add(key));
        const values = entries.map(([, member]) => add(member));
        objects[index] =
          `<dict><key>NS.keys</key><array>${keys.map(uid).join('')}</array><key>NS.objects</key><array>${values.map(uid).join('')}</array><key>$class</key>${uid(classOf('NSDictionary'))}</dict>`;
      }
      return index;
    };
    const root = add(value);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string>
<key>$version</key><integer>100000</integer>
<key>$top</key><dict><key>root</key>${uid(root)}</dict>
<key>$objects</key><array>${objects.join('')}</array></dict></plist>`;
    const file = join(this.#directory.path, 'archive.plist');
    await writeFile(file, xml);
    return execFileSync('/usr/bin/plutil', [
      '-convert',
      'binary1',
      '-o',
      '-',
      file,
    ]);
  }
}

test('accounts come with their type, parent, enabled data classes and decoded properties', async () => {
  await using store = await ScratchAccountsStore.create();
  await store.account({
    pk: 1,
    identifier: 'GOOGLE',
    type: 'com.apple.account.Google',
    description: 'Work',
    username: 'ann@example.com',
    enabled: ['com.apple.Dataclass.Mail', 'com.apple.Dataclass.Calendars'],
    properties: { ACPropertyFullName: 'Ann Example' },
  });
  await store.account({
    pk: 2,
    identifier: 'IMAP-1',
    type: 'com.apple.account.IMAP',
    parent: 1,
    properties: {
      Hostname: 'imap.example.com',
      PortNumber: 993,
      SSLEnabled: true,
      EmailAliases: [
        {
          DisplayName: 'Ann',
          EmailAddresses: ['ann@example.com', 'a@example.com'],
          IsPrimary: true,
        },
      ],
    },
    dataclassProperties: {
      'com.apple.Dataclass.Mail': { StoreSentMessagesOnServer: true },
    },
  });
  await store.account({
    pk: 3,
    identifier: 'IDLE',
    type: 'com.apple.account.IMAP',
    active: false,
  });

  const accounts = new AccountsStore(store.path).read();

  assert.deepEqual(accounts, [
    {
      identifier: 'GOOGLE',
      type: 'com.apple.account.Google',
      parent: null,
      description: 'Work',
      username: 'ann@example.com',
      active: true,
      enabledDataclasses: [
        'com.apple.Dataclass.Mail',
        'com.apple.Dataclass.Calendars',
      ],
      properties: { ACPropertyFullName: 'Ann Example' },
      dataclassProperties: {},
    },
    {
      identifier: 'IMAP-1',
      type: 'com.apple.account.IMAP',
      parent: 'GOOGLE',
      description: null,
      username: null,
      active: true,
      enabledDataclasses: [],
      properties: {
        Hostname: 'imap.example.com',
        PortNumber: 993,
        SSLEnabled: true,
        EmailAliases: [
          {
            DisplayName: 'Ann',
            EmailAddresses: ['ann@example.com', 'a@example.com'],
            IsPrimary: true,
          },
        ],
      },
      dataclassProperties: {
        'com.apple.Dataclass.Mail': { StoreSentMessagesOnServer: true },
      },
    },
    {
      identifier: 'IDLE',
      type: 'com.apple.account.IMAP',
      parent: null,
      description: null,
      username: null,
      active: false,
      enabledDataclasses: [],
      properties: {},
      dataclassProperties: {},
    },
  ]);
});

test('a store that cannot be opened fails with AccountsUnavailableError', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'accounts-'));
  const path = join(scratch.path, 'missing', 'Accounts4.sqlite');

  assert.throws(
    () => new AccountsStore(path).read(),
    (error: unknown) => {
      assert.ok(error instanceof AccountsUnavailableError);
      assert.match(error.message, /Full Disk Access/);
      assert.ok(error.message.includes(path));
      return true;
    },
  );
  assert.throws(
    () => new AccountsStore(path).version(),
    AccountsUnavailableError,
  );
});

test('the store version changes when another connection commits', async () => {
  await using scratch = await ScratchAccountsStore.create();
  using version = new AccountsStore(scratch.path).version();
  const before = version.current;

  await scratch.account({
    pk: 1,
    identifier: 'ACCOUNT',
    type: 'com.apple.account.IMAP',
  });

  assert.notEqual(version.current, before);
});

test('this Mac’s Accounts store reads as accounts whose parents exist', (t) => {
  if (process.platform !== 'darwin') return t.skip('Accounts requires macOS');
  const store = new AccountsStore(accountsStorePath);

  let accounts;
  try {
    accounts = store.read();
  } catch (error) {
    if (error instanceof AccountsUnavailableError)
      return t.skip('no access to the Accounts store');
    throw error;
  }

  const identifiers = new Set(accounts.map(({ identifier }) => identifier));
  for (const account of accounts) {
    assert.match(account.type, /^com\.apple\.account\./);
    assert.ok(account.parent === null || identifiers.has(account.parent));
    for (const dataclass of account.enabledDataclasses)
      assert.match(dataclass, /^com\.apple\.Dataclass\./);
  }
});
