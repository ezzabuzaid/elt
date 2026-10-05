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
  mailDataclass,
} from './index.ts';

type Archivable =
  | string
  | number
  | boolean
  | readonly Archivable[]
  | { readonly [key: string]: Archivable };

// A synthetic Accounts4.sqlite with the tables macOS 27's Accounts framework
// writes, as its schema declares them, and values stored as real
// NSKeyedArchiver archives.
class ScratchAccountsStore implements AsyncDisposable {
  readonly path: string;
  readonly #directory: AsyncDisposable & { readonly path: string };
  readonly #database: DatabaseSync;

  private constructor(directory: AsyncDisposable & { readonly path: string }) {
    this.#directory = directory;
    this.path = join(directory.path, 'Accounts4.sqlite');
    this.#database = new DatabaseSync(this.path);
    this.#database.exec(`
      CREATE TABLE ZACCESSOPTIONSKEY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNAME VARCHAR , ZENUMVALUE INTEGER);
      CREATE TABLE Z_1OWNINGACCOUNTTYPES ( Z_1ACCESSKEYS INTEGER, Z_4OWNINGACCOUNTTYPES INTEGER, PRIMARY KEY (Z_1ACCESSKEYS, Z_4OWNINGACCOUNTTYPES) );
      CREATE TABLE ZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACTIVE INTEGER, ZAUTHENTICATED INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZVISIBLE INTEGER, ZWARMINGUP INTEGER, ZACCOUNTTYPE INTEGER, ZPARENTACCOUNT INTEGER, ZDATE TIMESTAMP, ZLASTCREDENTIALRENEWALREJECTIONDATE TIMESTAMP, ZACCOUNTDESCRIPTION VARCHAR, ZAUTHENTICATIONTYPE VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZMODIFICATIONID VARCHAR, ZOWNINGBUNDLEID VARCHAR, ZUSERNAME VARCHAR, ZDATACLASSPROPERTIES BLOB );
      CREATE TABLE Z_2ENABLEDDATACLASSES ( Z_2ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER, PRIMARY KEY (Z_2ENABLEDACCOUNTS, Z_7ENABLEDDATACLASSES) );
      CREATE TABLE Z_2PROVISIONEDDATACLASSES ( Z_2PROVISIONEDACCOUNTS INTEGER, Z_7PROVISIONEDDATACLASSES INTEGER, PRIMARY KEY (Z_2PROVISIONEDACCOUNTS, Z_7PROVISIONEDDATACLASSES) );
      CREATE TABLE ZACCOUNTPROPERTY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZKEY VARCHAR, ZVALUE BLOB );
      CREATE TABLE ZACCOUNTTYPE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOBSOLETE INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZSUPPORTSMULTIPLEACCOUNTS INTEGER, ZVISIBILITY INTEGER, ZACCOUNTTYPEDESCRIPTION VARCHAR, ZCREDENTIALPROTECTIONPOLICY VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZOWNINGBUNDLEID VARCHAR );
      CREATE TABLE Z_4SUPPORTEDDATACLASSES ( Z_4SUPPORTEDTYPES INTEGER, Z_7SUPPORTEDDATACLASSES INTEGER, PRIMARY KEY (Z_4SUPPORTEDTYPES, Z_7SUPPORTEDDATACLASSES) );
      CREATE TABLE Z_4SYNCABLEDATACLASSES ( Z_4SYNCABLETYPES INTEGER, Z_7SYNCABLEDATACLASSES INTEGER, PRIMARY KEY (Z_4SYNCABLETYPES, Z_7SYNCABLEDATACLASSES) );
      CREATE TABLE ZAUTHORIZATION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACCOUNTTYPE INTEGER, ZBUNDLEID VARCHAR, ZGRANTEDPERMISSIONS VARCHAR, ZOPTIONS BLOB );
      CREATE TABLE ZCREDENTIALITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZPERSISTENT INTEGER, ZEXPIRATIONDATE TIMESTAMP, ZACCOUNTIDENTIFIER VARCHAR, ZSERVICENAME VARCHAR );
      CREATE TABLE ZDATACLASS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNAME BLOB , ZENUMVALUE INTEGER);
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

  using snapshot = new AccountsStore(store.path).open();
  const accounts = snapshot.accounts();

  assert.equal(accounts[1]?.parent, accounts[0]);
  assert.deepEqual(
    accounts.map((account) => ({
      identifier: account.identifier,
      type: account.type,
      parent: account.parent?.identifier ?? null,
      description: account.description,
      username: account.username,
      active: account.active,
      enabledDataclasses: account.enabledDataclasses,
      properties: account.properties,
      dataclassProperties: account.dataclassProperties,
    })),
    [
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
    ],
  );
});

test('an account answers its name, user, addresses and mail servers, through its parent where the store keeps them there', async () => {
  await using store = await ScratchAccountsStore.create();
  // iCloud as macOS 27 keeps it: the parent holds the name, the user and the
  // Mail servers; the IMAP and SMTP children hold only their own settings.
  await store.account({
    pk: 1,
    identifier: 'ICLOUD',
    type: 'com.apple.account.AppleAccount',
    description: 'iCloud',
    username: 'ann@example.com',
    enabled: [mailDataclass],
    properties: {
      ACPropertyFullName: 'Ann Example',
      appleIDAliases: ['ann@example.com', 'ann.alias@example.com'],
    },
    dataclassProperties: {
      [mailDataclass]: {
        EmailAddress: 'ann@icloud.example',
        imapHostname: 'imap.icloud.example',
        imapPort: 143,
        imapRequiresSSL: false,
        smtpHostname: 'smtp.icloud.example',
        smtpPort: 587,
        smtpRequiresSSL: true,
      },
    },
  });
  await store.account({
    pk: 2,
    identifier: 'IMAP',
    type: 'com.apple.account.IMAP',
    parent: 1,
    properties: {
      PortNumber: 993,
      SSLIsDirect: true,
      SendingAccountIdentifier: 'SMTP',
      EmailAliases: [
        { EmailAddresses: ['ann@icloud.example', 'ann@alias.example'] },
      ],
    },
  });
  // STARTTLS on 587: SSLIsDirect false is not TLS off.
  await store.account({
    pk: 3,
    identifier: 'SMTP',
    type: 'com.apple.account.SMTP',
    parent: 1,
    properties: {
      IdentityEmailAddress: 'ann@icloud.example',
      SSLIsDirect: false,
    },
  });
  // Exchange holds no server settings, only its web service URL.
  await store.account({
    pk: 4,
    identifier: 'EXCHANGE',
    type: 'com.apple.account.Exchange',
    description: 'Work',
    username: 'ann@work.example',
    enabled: [mailDataclass],
    properties: {
      EWSExternalURL: 'https://mail.work.example/EWS/Exchange.asmx',
      IdentityEmailAddress: 'ann@work.example',
      SendingAccountIdentifier: 'EXCHANGE',
    },
  });

  using snapshot = new AccountsStore(store.path).open();
  const [, imap, smtp, exchange] = snapshot.accounts();

  assert.ok(imap && smtp && exchange);
  assert.equal(imap.name, 'iCloud');
  assert.equal(imap.fullName, 'Ann Example');
  assert.equal(imap.userName, 'ann@example.com');
  assert.deepEqual(imap.emailAddresses, [
    'ann@icloud.example',
    'ann@alias.example',
    'ann@example.com',
    'ann.alias@example.com',
  ]);
  assert.equal(imap.enabledFor(mailDataclass), true);
  assert.equal(imap.sendingAccountIdentifier, 'SMTP');
  assert.deepEqual(imap.incomingMailServer, {
    host: 'imap.icloud.example',
    port: 993,
    usesTls: true,
    userName: 'ann@example.com',
  });
  assert.equal(smtp.name, 'iCloud');
  assert.deepEqual(smtp.outgoingMailServer, {
    host: 'smtp.icloud.example',
    port: 587,
    usesTls: true,
    userName: 'ann@icloud.example',
  });
  assert.deepEqual(exchange.incomingMailServer, {
    host: 'mail.work.example',
    port: null,
    usesTls: true,
    userName: 'ann@work.example',
  });
  assert.equal(exchange.sendingAccountIdentifier, 'EXCHANGE');
});

test('a store that cannot be opened fails with AccountsUnavailableError', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'accounts-'));
  const path = join(scratch.path, 'missing', 'Accounts4.sqlite');

  assert.throws(
    () => new AccountsStore(path).open(),
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

test('this Mac’s Accounts store reads as one consistent snapshot: accounts, their types and data classes, and access keys', (t) => {
  if (process.platform !== 'darwin') return t.skip('Accounts requires macOS');
  const store = new AccountsStore(accountsStorePath);

  let read;
  try {
    using snapshot = store.open();
    read = {
      accounts: snapshot.accounts(),
      accountTypes: snapshot.accountTypes(),
      dataclasses: snapshot.dataclasses(),
      accessOptionKeys: snapshot.accessOptionKeys(),
      authorizations: snapshot.authorizations(),
      credentialItems: snapshot.credentialItems(),
    };
  } catch (error) {
    if (error instanceof AccountsUnavailableError)
      return t.skip('no access to the Accounts store');
    throw error;
  }

  // Checked without printing a value: these are the user's own accounts.
  const { accounts, accountTypes, dataclasses, accessOptionKeys } = read;
  const types = new Set(accountTypes.map(({ identifier }) => identifier));
  const dataclassNames = new Set(dataclasses.map(({ name }) => name));
  assert.equal(types.size, accountTypes.length);
  assert.equal(dataclassNames.size, dataclasses.length);
  for (const account of accounts) {
    assert.ok(types.has(account.type));
    assert.ok(account.parent === null || accounts.includes(account.parent));
    for (const dataclass of [
      ...account.enabledDataclasses,
      ...account.provisionedDataclasses,
    ])
      assert.ok(dataclassNames.has(dataclass));
  }
  for (const type of accountTypes)
    for (const dataclass of [
      ...type.supportedDataclasses,
      ...type.syncableDataclasses,
    ])
      assert.ok(dataclassNames.has(dataclass));
  for (const key of accessOptionKeys)
    for (const type of key.accountTypes) assert.ok(types.has(type));
});
