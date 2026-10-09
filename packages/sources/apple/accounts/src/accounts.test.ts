import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Connection, Copy, Pipeline, PipelineError } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import {
  AccountsSchemaError,
  AccountsUnavailableError,
  accountsStorePath,
} from '@workspace/sdk-apple-accounts';

import { AppleAccountsSource } from './apple-accounts-source.ts';

type Archivable =
  | string
  | number
  | boolean
  | readonly Archivable[]
  | { readonly [key: string]: Archivable };

// A synthetic Accounts4.sqlite with every table macOS 27's Accounts framework
// writes, as its schema declares them, and values stored as real
// NSKeyedArchiver archives.
class ScratchAccountsStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);
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

  dataclass(name: string, enumValue: number): void {
    this.#database
      .prepare('INSERT INTO ZDATACLASS (ZNAME, ZENUMVALUE) VALUES (?, ?)')
      .run(this.#archive(name), enumValue);
  }

  accountType(type: {
    readonly identifier: string;
    readonly description: string;
    readonly supported?: readonly string[];
    readonly syncable?: readonly string[];
  }): void {
    const pk = Number(
      this.#database
        .prepare(
          `INSERT INTO ZACCOUNTTYPE (ZIDENTIFIER, ZACCOUNTTYPEDESCRIPTION,
             ZSUPPORTSAUTHENTICATION, ZSUPPORTSMULTIPLEACCOUNTS, ZOBSOLETE,
             ZVISIBILITY)
           VALUES (?, ?, 1, 1, 0, 1)`,
        )
        .run(type.identifier, type.description).lastInsertRowid,
    );
    for (const name of type.supported ?? [])
      this.#database
        .prepare('INSERT INTO Z_4SUPPORTEDDATACLASSES VALUES (?, ?)')
        .run(pk, this.#dataclassKey(name));
    for (const name of type.syncable ?? [])
      this.#database
        .prepare('INSERT INTO Z_4SYNCABLEDATACLASSES VALUES (?, ?)')
        .run(pk, this.#dataclassKey(name));
  }

  account(account: {
    readonly pk: number;
    readonly identifier: string;
    readonly type: string;
    readonly parent?: number;
    readonly description?: string;
    readonly username?: string;
    // Core Data seconds since 2001-01-01.
    readonly date?: number;
    readonly enabled?: readonly string[];
    readonly provisioned?: readonly string[];
    readonly properties?: { readonly [key: string]: Archivable };
    readonly dataclassProperties?: { readonly [key: string]: Archivable };
  }): void {
    this.#database
      .prepare(
        `INSERT INTO ZACCOUNT (Z_PK, ZACTIVE, ZAUTHENTICATED,
           ZSUPPORTSAUTHENTICATION, ZVISIBLE, ZWARMINGUP, ZACCOUNTTYPE,
           ZPARENTACCOUNT, ZDATE, ZACCOUNTDESCRIPTION, ZAUTHENTICATIONTYPE,
           ZIDENTIFIER, ZMODIFICATIONID, ZOWNINGBUNDLEID, ZUSERNAME,
           ZDATACLASSPROPERTIES)
         VALUES (?, 1, 1, 1, 1, NULL, ?, ?, ?, ?, 'parent', ?, ?,
           'com.apple.systempreferences', ?, ?)`,
      )
      .run(
        account.pk,
        this.#typeKey(account.type),
        account.parent ?? null,
        account.date ?? null,
        account.description ?? null,
        account.identifier,
        `MOD-${account.pk}`,
        account.username ?? null,
        account.dataclassProperties === undefined
          ? null
          : this.#archive(account.dataclassProperties),
      );
    for (const [key, value] of Object.entries(account.properties ?? {}))
      this.#database
        .prepare(
          'INSERT INTO ZACCOUNTPROPERTY (ZOWNER, ZKEY, ZVALUE) VALUES (?, ?, ?)',
        )
        .run(account.pk, key, this.#archive(value));
    for (const name of account.enabled ?? [])
      this.#database
        .prepare('INSERT INTO Z_2ENABLEDDATACLASSES VALUES (?, ?)')
        .run(account.pk, this.#dataclassKey(name));
    for (const name of account.provisioned ?? [])
      this.#database
        .prepare('INSERT INTO Z_2PROVISIONEDDATACLASSES VALUES (?, ?)')
        .run(account.pk, this.#dataclassKey(name));
  }

  accessOptionKey(name: string, enumValue: number, types: readonly string[]) {
    const pk = Number(
      this.#database
        .prepare(
          'INSERT INTO ZACCESSOPTIONSKEY (ZNAME, ZENUMVALUE) VALUES (?, ?)',
        )
        .run(name, enumValue).lastInsertRowid,
    );
    for (const type of types)
      this.#database
        .prepare('INSERT INTO Z_1OWNINGACCOUNTTYPES VALUES (?, ?)')
        .run(pk, this.#typeKey(type));
  }

  authorization(
    type: string,
    bundleId: string,
    permissions: string,
    options: { readonly [key: string]: Archivable },
  ): void {
    this.#database
      .prepare(
        `INSERT INTO ZAUTHORIZATION (ZACCOUNTTYPE, ZBUNDLEID,
           ZGRANTEDPERMISSIONS, ZOPTIONS) VALUES (?, ?, ?, ?)`,
      )
      .run(this.#typeKey(type), bundleId, permissions, this.#archive(options));
  }

  credentialItem(account: string, service: string, expires: number): void {
    this.#database
      .prepare(
        `INSERT INTO ZCREDENTIALITEM (ZACCOUNTIDENTIFIER, ZSERVICENAME,
           ZEXPIRATIONDATE, ZPERSISTENT) VALUES (?, ?, ?, 1)`,
      )
      .run(account, service, expires);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }

  #typeKey(identifier: string): number {
    const found = this.#database
      .prepare('SELECT Z_PK FROM ZACCOUNTTYPE WHERE ZIDENTIFIER = ?')
      .get(identifier)?.Z_PK;
    assert.ok(found !== undefined, `${identifier} is not a fixture type`);
    return Number(found);
  }

  #dataclassKey(name: string): number {
    const archived = this.#archive(name);
    for (const { Z_PK, ZNAME } of this.#database
      .prepare('SELECT Z_PK, ZNAME FROM ZDATACLASS')
      .all())
      if (Buffer.from(Object(ZNAME)).equals(archived)) return Number(Z_PK);
    assert.fail(`${name} is not a fixture data class`);
  }

  // Writes value as an NSKeyedArchiver XML plist and lets plutil turn it into
  // the binary archive the Accounts framework stores.
  #archive(value: Archivable): Buffer {
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
    return execFileSync(
      '/usr/bin/plutil',
      ['-convert', 'binary1', '-o', '-', '-'],
      {
        input: `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>$archiver</key><string>NSKeyedArchiver</string>
<key>$version</key><integer>100000</integer>
<key>$top</key><dict><key>root</key>${uid(root)}</dict>
<key>$objects</key><array>${objects.join('')}</array></dict></plist>`,
      },
    );
  }
}

const mail = 'com.apple.Dataclass.Mail';
const calendars = 'com.apple.Dataclass.Calendars';
const contacts = 'com.apple.Dataclass.Contacts';
// Core Data seconds since 2001-01-01, and the instant they name.
const added = 800000000.5;
const addedAt = new Date((978307200 + added) * 1000).toISOString();

// An iCloud account with its IMAP and SMTP children, the identity service
// and iTunes Store accounts that keep authentication material, and the
// Accounts framework's catalog of types, data classes and access keys.
function accountsFixture(path: string): void {
  using store = new ScratchAccountsStore(path);
  store.dataclass(mail, 1);
  store.dataclass(calendars, 2);
  store.dataclass(contacts, 3);
  store.accountType({
    identifier: 'com.apple.account.AppleAccount',
    description: 'iCloud',
    supported: [mail, calendars, contacts],
    syncable: [mail, calendars],
  });
  store.accountType({
    identifier: 'com.apple.account.IMAP',
    description: 'IMAP',
    supported: [mail],
  });
  store.accountType({
    identifier: 'com.apple.account.SMTP',
    description: 'SMTP',
  });
  store.accountType({
    identifier: 'com.apple.account.IdentityServices',
    description: 'Identity Services',
  });
  store.accountType({
    identifier: 'com.apple.account.iTunesStore',
    description: 'iTunes Store',
  });
  store.accountType({
    identifier: 'com.apple.account.Facebook',
    description: 'Facebook',
  });
  store.account({
    pk: 1,
    identifier: 'ICLOUD',
    type: 'com.apple.account.AppleAccount',
    description: 'iCloud',
    username: 'ann@example.com',
    date: added,
    enabled: [mail, calendars],
    provisioned: [mail, calendars, contacts],
    properties: {
      ACPropertyFullName: 'Ann Example',
      appleIDAliases: ['ann@example.com'],
      nextLivenessNonce: 'NONCE',
    },
    dataclassProperties: {
      [mail]: { EmailAddress: 'ann@icloud.example', smtpPort: 587 },
    },
  });
  store.account({
    pk: 2,
    identifier: 'IMAP',
    type: 'com.apple.account.IMAP',
    parent: 1,
    properties: { PortNumber: 993, SSLIsDirect: true },
  });
  store.account({
    pk: 3,
    identifier: 'SMTP',
    type: 'com.apple.account.SMTP',
    parent: 1,
    properties: { IdentityEmailAddress: 'ann@icloud.example' },
  });
  store.account({
    pk: 4,
    identifier: 'IDS',
    type: 'com.apple.account.IdentityServices',
    properties: {
      'account-info': {
        SelfHandle: 'mailto:ann@example.com',
        AppleID: 'ann@example.com',
        AuthID: 'AUTH-ID',
      },
    },
  });
  store.account({
    pk: 5,
    identifier: 'ITUNES',
    type: 'com.apple.account.iTunesStore',
    properties: {
      storefrontID: '143441',
      lastAuthenticationServerResponse: {
        iv: 'IV',
        data: 'CIPHERTEXT',
        tag: 'TAG',
      },
      GKPlayerInternal: 'OPAQUE',
    },
  });
  store.accessOptionKey('ACFacebookAppIdKey', 1, [
    'com.apple.account.Facebook',
  ]);
  store.authorization('com.apple.account.Facebook', 'com.example.app', 'read', {
    ACFacebookAppIdKey: '123',
  });
  store.credentialItem('ICLOUD', 'com.apple.account.AppleAccount.token', added);
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

async function pipeline(source: AppleAccountsSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const { streams } = await source.discover();
  return new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'state.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
}

// Each kind of failure a run's copies reported, once.
function failureTypes(error: {
  readonly results: readonly {
    readonly failures: readonly { readonly failureType: string }[];
  }[];
}): string[] {
  return [
    ...new Set(
      error.results.flatMap(({ failures }) =>
        failures.map(({ failureType }) => failureType),
      ),
    ),
  ];
}

test('every Accounts stream loads the store, without authentication material, and a second run writes nothing', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-accounts-'));
  const path = join(dir.path, 'Accounts4.sqlite');
  accountsFixture(path);
  const source = new AppleAccountsSource({ path });
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');

  const first = await run.run();

  assert.equal(first.length, 8);
  assert.ok(first.every((result) => result.count > 0));
  assert.deepEqual(
    rows(
      out,
      `SELECT id, type, parentId, description, name, username, fullName,
              emailAddresses, active, authenticated, createdAt,
              owningBundleId, dataclassProperties
       FROM accounts WHERE id IN ('ICLOUD', 'IMAP') ORDER BY id`,
    ),
    [
      {
        id: 'ICLOUD',
        type: 'com.apple.account.AppleAccount',
        parentId: null,
        description: 'iCloud',
        name: 'iCloud',
        username: 'ann@example.com',
        fullName: 'Ann Example',
        emailAddresses: JSON.stringify([
          'ann@example.com',
          'ann@icloud.example',
        ]),
        active: 1,
        authenticated: 1,
        createdAt: addedAt,
        owningBundleId: 'com.apple.systempreferences',
        dataclassProperties: JSON.stringify({
          [mail]: { EmailAddress: 'ann@icloud.example', smtpPort: 587 },
        }),
      },
      {
        id: 'IMAP',
        type: 'com.apple.account.IMAP',
        parentId: 'ICLOUD',
        description: null,
        name: 'iCloud',
        username: null,
        fullName: 'Ann Example',
        emailAddresses: JSON.stringify([
          'ann@example.com',
          'ann@icloud.example',
        ]),
        active: 1,
        authenticated: 1,
        createdAt: null,
        owningBundleId: 'com.apple.systempreferences',
        dataclassProperties: '{}',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT accountId, key, value FROM accountProperties ORDER BY accountId, key',
    ),
    [
      {
        accountId: 'ICLOUD',
        key: 'ACPropertyFullName',
        value: '"Ann Example"',
      },
      {
        accountId: 'ICLOUD',
        key: 'appleIDAliases',
        value: '["ann@example.com"]',
      },
      {
        accountId: 'IDS',
        key: 'account-info',
        value: JSON.stringify({
          SelfHandle: 'mailto:ann@example.com',
          AppleID: 'ann@example.com',
        }),
      },
      { accountId: 'IMAP', key: 'PortNumber', value: '993' },
      { accountId: 'IMAP', key: 'SSLIsDirect', value: 'true' },
      { accountId: 'ITUNES', key: 'storefrontID', value: '"143441"' },
      {
        accountId: 'SMTP',
        key: 'IdentityEmailAddress',
        value: '"ann@icloud.example"',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT accountId, dataclass, enabled, provisioned FROM accountDataclasses ORDER BY accountId, dataclass',
    ),
    [
      { accountId: 'ICLOUD', dataclass: calendars, enabled: 1, provisioned: 1 },
      { accountId: 'ICLOUD', dataclass: contacts, enabled: 0, provisioned: 1 },
      { accountId: 'ICLOUD', dataclass: mail, enabled: 1, provisioned: 1 },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      `SELECT id, description, supportedDataclasses, syncableDataclasses
       FROM accountTypes WHERE id = 'com.apple.account.AppleAccount'`,
    ),
    [
      {
        id: 'com.apple.account.AppleAccount',
        description: 'iCloud',
        supportedDataclasses: JSON.stringify([mail, calendars, contacts]),
        syncableDataclasses: JSON.stringify([mail, calendars]),
      },
    ],
  );
  assert.equal(rows(out, 'SELECT * FROM accountTypes').length, 6);
  assert.deepEqual(
    rows(out, 'SELECT name, enumValue FROM dataclasses ORDER BY enumValue'),
    [
      { name: mail, enumValue: 1 },
      { name: calendars, enumValue: 2 },
      { name: contacts, enumValue: 3 },
    ],
  );
  assert.deepEqual(
    rows(out, 'SELECT name, enumValue, accountTypes FROM accessOptionKeys'),
    [
      {
        name: 'ACFacebookAppIdKey',
        enumValue: 1,
        accountTypes: JSON.stringify(['com.apple.account.Facebook']),
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT accountType, bundleId, grantedPermissions, options FROM authorizations',
    ),
    [
      {
        accountType: 'com.apple.account.Facebook',
        bundleId: 'com.example.app',
        grantedPermissions: 'read',
        options: JSON.stringify({ ACFacebookAppIdKey: '123' }),
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT accountId, serviceName, expiresAt, persistent FROM credentialItems',
    ),
    [
      {
        accountId: 'ICLOUD',
        serviceName: 'com.apple.account.AppleAccount.token',
        expiresAt: addedAt,
        persistent: 1,
      },
    ],
  );

  const second = await run.run();

  assert.ok(second.every((result) => result.count === 0));
});

test('an account changed in the store updates its rows, and a removed one deletes them', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-accounts-'));
  const path = join(dir.path, 'Accounts4.sqlite');
  accountsFixture(path);
  const run = await pipeline(new AppleAccountsSource({ path }), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  {
    using store = new DatabaseSync(path);
    store.exec(`
      UPDATE ZACCOUNT SET ZACCOUNTDESCRIPTION = 'Personal' WHERE ZIDENTIFIER = 'ICLOUD';
      DELETE FROM ZACCOUNTPROPERTY WHERE ZOWNER = 3;
      DELETE FROM ZACCOUNT WHERE ZIDENTIFIER = 'SMTP';
    `);
  }

  await run.run();

  assert.deepEqual(rows(out, 'SELECT id, name FROM accounts ORDER BY id'), [
    { id: 'ICLOUD', name: 'Personal' },
    { id: 'IDS', name: null },
    { id: 'IMAP', name: 'Personal' },
    { id: 'ITUNES', name: null },
  ]);
  assert.deepEqual(
    rows(out, "SELECT key FROM accountProperties WHERE accountId = 'SMTP'"),
    [],
  );
});

test('an unreadable Accounts store fails every stream, naming Full Disk Access', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-accounts-'));
  const source = new AppleAccountsSource({
    path: join(dir.path, 'missing', 'Accounts4.sqlite'),
  });

  await assert.rejects((await pipeline(source, dir.path)).run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.ok(error.errors.length > 0);
    for (const cause of error.errors) {
      assert.ok(cause instanceof AccountsUnavailableError);
      assert.match(cause.message, /Full Disk Access/);
    }
    assert.deepEqual(failureTypes(error), ['config']);
    return true;
  });
});

test('a table in a layout this reader does not know fails only the stream that reads it, by name, and the others load', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-accounts-'));
  const path = join(dir.path, 'Accounts4.sqlite');
  accountsFixture(path);
  {
    using store = new DatabaseSync(path);
    store.exec('ALTER TABLE ZAUTHORIZATION DROP COLUMN ZOPTIONS');
  }
  const out = join(dir.path, 'out.sqlite');

  await assert.rejects(
    (await pipeline(new AppleAccountsSource({ path }), dir.path)).run(),
    (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, 1);
      const [cause] = error.errors;
      assert.ok(cause instanceof AccountsSchemaError);
      assert.match(cause.message, /ZAUTHORIZATION\.ZOPTIONS/);
      return true;
    },
  );

  for (const stream of [
    'accounts',
    'accountProperties',
    'accountDataclasses',
    'accountTypes',
    'dataclasses',
    'accessOptionKeys',
    'credentialItems',
  ])
    assert.ok(
      Number(rows(out, `SELECT count(*) AS n FROM ${stream}`)[0]?.n) > 0,
      stream,
    );
});

test('watching the Accounts store reports each commit to it', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-accounts-'));
  const path = join(dir.path, 'Accounts4.sqlite');
  accountsFixture(path);
  const source = new AppleAccountsSource({ path });
  const abort = new AbortController();
  const watch = source.watch({
    streams: [source.accounts, source.accountProperties],
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  });
  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.accountProperties,
  ]);

  {
    using store = new DatabaseSync(path);
    store.exec(
      "UPDATE ZACCOUNT SET ZACCOUNTDESCRIPTION = 'Personal' WHERE ZIDENTIFIER = 'ICLOUD'",
    );
  }

  assert.deepEqual((await watch.next()).value, [
    source.accounts,
    source.accountProperties,
  ]);
  abort.abort();
  assert.equal((await watch.next()).done, true);
});

test('this Mac’s Accounts store loads every stream, one row per stored record, without authentication material', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Accounts requires macOS');
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-accounts-live-'),
  );
  const source = new AppleAccountsSource();
  const out = join(dir.path, 'out.sqlite');

  try {
    await (await pipeline(source, dir.path)).run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every((cause) => cause instanceof AccountsUnavailableError)
    )
      return t.skip('no access to the Accounts store');
    throw error;
  }

  // Counted, never printed: these are the user's own accounts.
  const stored = (sql: string) => Number(rows(accountsStorePath, sql)[0]?.n);
  const loaded = (table: string) =>
    Number(rows(out, `SELECT count(*) AS n FROM ${table}`)[0]?.n);
  assert.equal(
    loaded('accounts'),
    stored('SELECT count(*) AS n FROM ZACCOUNT'),
  );
  assert.equal(
    loaded('accountTypes'),
    stored('SELECT count(*) AS n FROM ZACCOUNTTYPE'),
  );
  assert.equal(
    loaded('dataclasses'),
    stored('SELECT count(*) AS n FROM ZDATACLASS'),
  );
  assert.equal(
    loaded('accessOptionKeys'),
    stored('SELECT count(*) AS n FROM ZACCESSOPTIONSKEY'),
  );
  assert.equal(
    loaded('authorizations'),
    stored('SELECT count(*) AS n FROM ZAUTHORIZATION'),
  );
  assert.equal(
    loaded('credentialItems'),
    stored('SELECT count(*) AS n FROM ZCREDENTIALITEM'),
  );
  assert.equal(
    loaded('accountProperties'),
    stored(
      "SELECT count(*) AS n FROM ZACCOUNTPROPERTY WHERE ZKEY NOT IN ('lastAuthenticationServerResponse', 'nextLivenessNonce', 'GKPlayerInternal')",
    ),
  );
  // The join tables' names are this macOS version's (Z_2…).
  assert.equal(
    loaded('accountDataclasses'),
    stored(
      'SELECT count(*) AS n FROM (SELECT Z_2ENABLEDACCOUNTS, Z_7ENABLEDDATACLASSES FROM Z_2ENABLEDDATACLASSES UNION SELECT Z_2PROVISIONEDACCOUNTS, Z_7PROVISIONEDDATACLASSES FROM Z_2PROVISIONEDDATACLASSES)',
    ),
  );
  assert.equal(
    rows(
      out,
      "SELECT count(*) AS n FROM accountProperties WHERE key IN ('lastAuthenticationServerResponse', 'nextLivenessNonce', 'GKPlayerInternal') OR value LIKE '%\"AuthID\"%'",
    )[0]?.n,
    0,
  );
});
