import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';

import {
  Connection,
  Copy,
  type CopyResult,
  Pipeline,
  PipelineError,
  type Target,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
} from '@workspace/elt-sqlite';
import {
  NotificationCenterSchemaError,
  NotificationCenterUnavailableError,
  notificationCenterStorePath,
} from '@workspace/sdk-apple-notification-center';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

import { AppleNotificationCenterSource } from './apple-notification-center-source.ts';

// A synthetic Notification Center store with every table macOS 27's usernoted
// creates (database version 19), as its schema declares them, in WAL mode as
// usernoted keeps it.
class ScratchNotificationCenter implements Disposable {
  readonly #database: DatabaseSync;

  // existing opens a store already made, as usernoted does when it delivers.
  constructor(path: string, { existing = false } = {}) {
    this.#database = new DatabaseSync(path);
    if (existing) return;
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE dbinfo (key VARCHAR, value VARCHAR);
      CREATE TABLE app (app_id INTEGER PRIMARY KEY, identifier VARCHAR, badge INTEGER NULL);
      CREATE TABLE record (rec_id INTEGER PRIMARY KEY, app_id INTEGER, uuid BLOB, data BLOB, request_date REAL, request_last_date REAL, delivered_date REAL, presented Bool, style INTEGER, snooze_fire_date REAL);
      CREATE TABLE requests (app_id INTEGER PRIMARY KEY, list BLOB);
      CREATE TABLE delivered (app_id INTEGER PRIMARY KEY, list BLOB);
      CREATE TABLE displayed (app_id INTEGER PRIMARY KEY, list BLOB);
      CREATE TABLE categories (app_id INTEGER PRIMARY KEY, categories BLOB);
      CREATE TRIGGER app_deleted AFTER DELETE ON app
      BEGIN
          DELETE FROM record WHERE app_id=old.app_id;
          DELETE FROM requests WHERE app_id=old.app_id;
          DELETE FROM delivered WHERE app_id=old.app_id;
          DELETE FROM displayed WHERE app_id=old.app_id;
          DELETE FROM categories WHERE app_id=old.app_id;
      END;
      INSERT INTO dbinfo VALUES ('compatibleVersion', '17'), ('version', '19'), ('build', '26A428');
    `);
  }

  insert(table: string, row: Record<string, SQLInputValue>): void {
    const columns = Object.keys(row);
    this.#database
      .prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      )
      .run(...Object.values(row));
  }

  delete(sql: string): void {
    this.#database.exec(sql);
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}

// A plist value as usernoted writes it: a real where it stores a double, even
// a whole one, and a keyed archive where it stores a Foundation object.
class Real {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}
class Uid {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}
type PlistInput =
  | string
  | number
  | boolean
  | Real
  | Uid
  | Uint8Array
  | PlistInput[]
  | { [key: string]: PlistInput };

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function plistXml(value: PlistInput): string {
  if (typeof value === 'string') return `<string>${escape(value)}</string>`;
  if (typeof value === 'boolean') return value ? '<true/>' : '<false/>';
  if (typeof value === 'number') return `<integer>${value}</integer>`;
  if (value instanceof Real) return `<real>${value.value}</real>`;
  if (value instanceof Uid)
    return `<dict><key>CF$UID</key><integer>${value.value}</integer></dict>`;
  if (value instanceof Uint8Array)
    return `<data>${Buffer.from(value).toString('base64')}</data>`;
  if (Array.isArray(value))
    return `<array>${value.map(plistXml).join('')}</array>`;
  return `<dict>${Object.entries(value)
    .map(([key, field]) => `<key>${escape(key)}</key>${plistXml(field)}`)
    .join('')}</dict>`;
}

const binaryPlist = (value: PlistInput) =>
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
    input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${plistXml(value)}</plist>`,
  });

// An NSDictionary of strings, archived as NSKeyedArchiver writes it, the way
// usernoted keeps a notification's userInfo and communication context.
function keyedArchive(entries: Record<string, string>): Uint8Array {
  const keys = Object.keys(entries);
  const objects: PlistInput[] = [
    '$null',
    {
      'NS.keys': keys.map((_, index) => new Uid(2 + index)),
      'NS.objects': keys.map((_, index) => new Uid(2 + keys.length + index)),
      $class: new Uid(2 + 2 * keys.length),
    },
    ...keys,
    ...Object.values(entries),
    { $classname: 'NSDictionary', $classes: ['NSDictionary', 'NSObject'] },
  ];
  return binaryPlist({
    $version: 100000,
    $archiver: 'NSKeyedArchiver',
    $top: { root: new Uid(1) },
    $objects: objects,
  });
}

// usernoted stores dates as seconds since 2001-01-01 in a double.
const appleTime = (iso: string, micros = 0) =>
  Date.parse(iso) / 1000 - 978307200 + micros / 1e6;
const uuidBytes = (uuid: string) =>
  Uint8Array.from(Buffer.from(uuid.replaceAll('-', ''), 'hex'));

type Delivery = {
  recId: number;
  appId: number;
  uuid: string;
  delivered: number;
  style: number;
  app: string;
  request: { [key: string]: PlistInput };
};

function deliver(store: ScratchNotificationCenter, delivery: Delivery): void {
  const uuid = uuidBytes(delivery.uuid);
  store.insert('record', {
    rec_id: delivery.recId,
    app_id: delivery.appId,
    uuid,
    data: binaryPlist({
      app: delivery.app,
      uuid,
      date: new Real(delivery.delivered),
      styl: delivery.style,
      orig: 2,
      srce: uuidBytes('00000000-0000-0000-0000-000000000001'),
      req: delivery.request,
    }),
    delivered_date: delivery.delivered,
    presented: 0,
    style: delivery.style,
  });
}

const messagesDelivery: Delivery = {
  recId: 1,
  appId: 1,
  uuid: '9FE19B3E-C190-4C21-B358-2D10E417FEB0',
  delivered: appleTime('2026-10-06T07:14:07.000Z', 997621),
  style: 1,
  app: 'com.apple.MobileSMS',
  request: {
    titl: 'Sam Rivera',
    subt: 'Weekend plans',
    body: 'Lunch at noon?',
    iden: 'message-1',
    thre: 'chat-1',
    cate: 'com.apple.messages.IncomingFilesCategory.Madrid',
    durl: 'messages://open?message-guid=GUID-1',
    soun: { nam: 'Note' },
    unct: 'UNNotificationContentTypeMessagingDirect',
    dest: 15,
    usda: keyedArchive({ CKBBContextKeyMessageGUID: 'GUID-1' }),
    uncc: keyedArchive({ identifier: 'chat-1' }),
  },
};

const codexDelivery: Delivery = {
  recId: 2,
  appId: 2,
  uuid: '00A11FCA-17A3-4A11-BE3E-B100BB1CA002',
  delivered: appleTime('2026-10-07T11:00:32.022Z'),
  style: 1,
  app: 'com.openai.codex',
  request: {
    titl: 'Task finished',
    body: 'Tests pass',
    iden: 'request-1',
    thre: 'conversation-1',
    intrp: 2,
    edat: new Real(appleTime('2026-10-07T15:00:00.000Z')),
    dest: 7,
    usda: keyedArchive({ conversation_id: 'conversation-1' }),
  },
};

// Script Editor posts through the legacy API, which sets no request
// identifier, thread or category.
const scriptEditorDelivery: Delivery = {
  recId: 3,
  appId: 3,
  uuid: '3FBB12A1-1C2A-411F-AD11-AB2B11F11F13',
  delivered: appleTime('2026-10-07T12:30:00.000Z', 125),
  style: 0,
  app: 'com.apple.ScriptEditor2',
  request: { titl: 'Script Editor', body: 'Done', dest: 7 },
};

// Three apps with a notification each; Messages has a badge and registered
// categories, one with a reply action and one whose title Messages localizes.
function notificationCenterFixture(path: string): void {
  using store = new ScratchNotificationCenter(path);
  store.insert('app', {
    app_id: 1,
    identifier: 'com.apple.mobilesms',
    badge: 2,
  });
  store.insert('app', {
    app_id: 2,
    identifier: 'com.openai.codex',
    badge: null,
  });
  store.insert('app', {
    app_id: 3,
    identifier: 'com.apple.scripteditor2',
    badge: null,
  });
  store.insert('categories', {
    app_id: 1,
    categories: binaryPlist([
      {
        id: 'com.apple.messages.IncomingFilesCategory.Madrid',
        opt: 384,
        ints: ['INSearchForMessagesIntent', 'INSendMessageIntent'],
        hidb: ['MADRID_MESSAGE_FORMAT', 'MADRID_MESSAGE_FORMAT', []],
        sumf: ['SINGLE_SUMMARY_FORMAT', 'SINGLE_SUMMARY_FORMAT', []],
        acts: [
          {
            id: 'com.apple.messages.ReplyAction',
            op: 0,
            st: 1,
            ti: ['Show More', 'Show More', []],
            tia: ['Send', 'Send', []],
            tip: ['Text Message', 'Text Message', []],
          },
        ],
      },
      {
        id: 'com.apple.messages.Mute',
        opt: 0,
        atit: 'Options',
        acts: [{ id: 'com.apple.messages.MuteAction', op: 2, ti: 'Mute' }],
      },
    ]),
  });
  deliver(store, messagesDelivery);
  deliver(store, codexDelivery);
  deliver(store, scriptEditorDelivery);
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

async function pipeline(
  source: AppleNotificationCenterSource,
  directory: string,
) {
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

const counts = (results: readonly CopyResult<Target>[]) =>
  Object.fromEntries(
    results.map(({ copy, count, deleted }) => [
      copy.from.name,
      { count, deleted },
    ]),
  );

test('a notification Notification Center drops stays loaded, while the next run loads only what is new', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // usernoted deletes a row when the app withdraws it, the user clears it or
  // a newer one replaces it, and records none of these.
  {
    using usernoted = new ScratchNotificationCenter(path, { existing: true });
    usernoted.delete('DELETE FROM record WHERE rec_id IN (1, 2)');
    deliver(usernoted, {
      ...scriptEditorDelivery,
      recId: 4,
      uuid: '4E000000-0000-4000-8000-000000000004',
      delivered: appleTime('2026-10-07T14:00:00.000Z'),
    });
  }

  const second = counts(await run.run());

  assert.deepEqual(second.notifications, { count: 1, deleted: 0 });
  assert.deepEqual(
    rows(out, 'SELECT id FROM notifications ORDER BY deliveredAt'),
    [
      { id: messagesDelivery.uuid },
      { id: codexDelivery.uuid },
      { id: scriptEditorDelivery.uuid },
      { id: '4E000000-0000-4000-8000-000000000004' },
    ],
  );
});

const unchanged = {
  notifications: { count: 0, deleted: 0 },
  apps: { count: 0, deleted: 0 },
  categories: { count: 0, deleted: 0 },
  categoryActions: { count: 0, deleted: 0 },
};

test('every Notification Center stream loads the store decoded, and a second run writes nothing', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const source = new AppleNotificationCenterSource(path);
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');

  const first = counts(await run.run());

  assert.deepEqual(first, {
    notifications: { count: 3, deleted: 0 },
    apps: { count: 3, deleted: 0 },
    categories: { count: 2, deleted: 0 },
    categoryActions: { count: 2, deleted: 0 },
  });
  const notificationFields = Object.keys(
    source.notifications.jsonSchema.properties ?? {},
  ).filter((field) => field !== 'payload');
  assert.deepEqual(
    rows(
      out,
      `SELECT ${notificationFields.join(', ')} FROM notifications ORDER BY deliveredAt`,
    ),
    [
      {
        id: messagesDelivery.uuid,
        bundleId: 'com.apple.MobileSMS',
        deliveredAt: '2026-10-06T07:14:07.997621Z',
        requestId: 'message-1',
        threadId: 'chat-1',
        category: 'com.apple.messages.IncomingFilesCategory.Madrid',
        title: 'Sam Rivera',
        subtitle: 'Weekend plans',
        body: 'Lunch at noon?',
        defaultActionUrl: 'messages://open?message-guid=GUID-1',
        soundName: 'Note',
        expiresAt: null,
        interruptionLevel: null,
        contentType: 'UNNotificationContentTypeMessagingDirect',
        style: 1,
        userInfo: '{"CKBBContextKeyMessageGUID":"GUID-1"}',
      },
      {
        id: codexDelivery.uuid,
        bundleId: 'com.openai.codex',
        deliveredAt: '2026-10-07T11:00:32.022000Z',
        requestId: 'request-1',
        threadId: 'conversation-1',
        category: null,
        title: 'Task finished',
        subtitle: null,
        body: 'Tests pass',
        defaultActionUrl: null,
        soundName: null,
        expiresAt: '2026-10-07T15:00:00.000000Z',
        interruptionLevel: 'timeSensitive',
        contentType: null,
        style: 1,
        userInfo: '{"conversation_id":"conversation-1"}',
      },
      {
        id: scriptEditorDelivery.uuid,
        bundleId: 'com.apple.ScriptEditor2',
        deliveredAt: '2026-10-07T12:30:00.000125Z',
        requestId: null,
        threadId: null,
        category: null,
        title: 'Script Editor',
        subtitle: null,
        body: 'Done',
        defaultActionUrl: null,
        soundName: null,
        expiresAt: null,
        interruptionLevel: null,
        contentType: null,
        style: 0,
        userInfo: null,
      },
    ],
  );
  // The payload keeps what usernoted stores beyond the named fields, with
  // nested archives decoded where they sit.
  const payload = JSON.parse(
    String(
      rows(
        out,
        `SELECT payload FROM notifications WHERE id = '${messagesDelivery.uuid}'`,
      )[0]?.payload,
    ),
  );
  assert.equal(payload.orig, 2);
  assert.equal(payload.req.dest, 15);
  assert.deepEqual(payload.req.uncc, { identifier: 'chat-1' });
  assert.deepEqual(
    rows(out, 'SELECT bundleId, badge FROM apps ORDER BY bundleId'),
    [
      { bundleId: 'com.apple.mobilesms', badge: 2 },
      { bundleId: 'com.apple.scripteditor2', badge: null },
      { bundleId: 'com.openai.codex', badge: null },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT bundleId, position, id, options, intentIdentifiers, hiddenPreviewsBodyPlaceholder, summaryFormat, actionsMenuTitle FROM categories ORDER BY position',
    ),
    [
      {
        bundleId: 'com.apple.mobilesms',
        position: 0,
        id: 'com.apple.messages.IncomingFilesCategory.Madrid',
        options: 384,
        intentIdentifiers:
          '["INSearchForMessagesIntent","INSendMessageIntent"]',
        hiddenPreviewsBodyPlaceholder: 'MADRID_MESSAGE_FORMAT',
        summaryFormat: 'SINGLE_SUMMARY_FORMAT',
        actionsMenuTitle: null,
      },
      {
        bundleId: 'com.apple.mobilesms',
        position: 1,
        id: 'com.apple.messages.Mute',
        options: 0,
        intentIdentifiers: null,
        hiddenPreviewsBodyPlaceholder: null,
        summaryFormat: null,
        actionsMenuTitle: 'Options',
      },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      'SELECT bundleId, categoryPosition, position, id, title, options, typeCode, textInputButtonTitle, textInputPlaceholder FROM categoryActions ORDER BY categoryPosition',
    ),
    [
      {
        bundleId: 'com.apple.mobilesms',
        categoryPosition: 0,
        position: 0,
        id: 'com.apple.messages.ReplyAction',
        title: 'Show More',
        options: 0,
        typeCode: 1,
        textInputButtonTitle: 'Send',
        textInputPlaceholder: 'Text Message',
      },
      {
        bundleId: 'com.apple.mobilesms',
        categoryPosition: 1,
        position: 0,
        id: 'com.apple.messages.MuteAction',
        title: 'Mute',
        options: 2,
        typeCode: null,
        textInputButtonTitle: null,
        textInputPlaceholder: null,
      },
    ],
  );

  assert.deepEqual(counts(await run.run()), unchanged);
});

test('an app that posts again under the same request loads the new notification beside the one it replaced', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // usernoted deletes the replaced row, and its rec_id is free for the next.
  {
    using usernoted = new ScratchNotificationCenter(path, { existing: true });
    usernoted.delete('DELETE FROM record WHERE rec_id = 2');
    deliver(usernoted, {
      ...codexDelivery,
      uuid: '7C0DE5E1-0000-4000-8000-000000000002',
      delivered: appleTime('2026-10-07T13:00:00.000Z'),
      request: { ...codexDelivery.request, titl: 'Task finished again' },
    });
  }

  const second = counts(await run.run());

  assert.deepEqual(second, {
    ...unchanged,
    notifications: { count: 1, deleted: 0 },
  });
  assert.deepEqual(
    rows(
      out,
      "SELECT id, requestId, title FROM notifications WHERE bundleId = 'com.openai.codex' ORDER BY deliveredAt",
    ),
    [
      {
        id: codexDelivery.uuid,
        requestId: 'request-1',
        title: 'Task finished',
      },
      {
        id: '7C0DE5E1-0000-4000-8000-000000000002',
        requestId: 'request-1',
        title: 'Task finished again',
      },
    ],
  );
});

test('a category an app registered twice loads both, told apart by position', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  {
    using usernoted = new ScratchNotificationCenter(path, { existing: true });
    usernoted.insert('categories', {
      app_id: 2,
      categories: binaryPlist([
        { id: 'payment-due', opt: 0, acts: [] },
        {
          id: 'payment-due',
          opt: 2176,
          acts: [{ id: 'pay', op: 4, ti: 'Pay' }],
        },
      ]),
    });
  }
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');

  await run.run();

  assert.deepEqual(
    rows(
      out,
      "SELECT position, id, options FROM categories WHERE bundleId = 'com.openai.codex' ORDER BY position",
    ),
    [
      { position: 0, id: 'payment-due', options: 0 },
      { position: 1, id: 'payment-due', options: 2176 },
    ],
  );
  assert.deepEqual(
    rows(
      out,
      "SELECT categoryPosition, id FROM categoryActions WHERE bundleId = 'com.openai.codex'",
    ),
    [{ categoryPosition: 1, id: 'pay' }],
  );
});

test('an app macOS forgets deletes its app and categories while its notifications stay', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // usernoted's app_deleted trigger takes the app's records and categories.
  {
    using usernoted = new ScratchNotificationCenter(path, { existing: true });
    usernoted.delete('DELETE FROM app WHERE app_id = 1');
  }

  const second = counts(await run.run());

  assert.deepEqual(second, {
    notifications: { count: 0, deleted: 0 },
    apps: { count: 0, deleted: 1 },
    categories: { count: 0, deleted: 2 },
    categoryActions: { count: 0, deleted: 2 },
  });
  assert.deepEqual(
    rows(
      out,
      "SELECT id FROM notifications WHERE bundleId = 'com.apple.MobileSMS'",
    ),
    [{ id: messagesDelivery.uuid }],
  );
});

test('a date range loads the notifications delivered in it, to the microsecond, and every app and category', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const scopes: [ImportScope, string[]][] = [
    [
      { startAt: '2026-10-07T00:00:00.000Z' },
      [codexDelivery.uuid, scriptEditorDelivery.uuid],
    ],
    // Delivered at 12:30:00.000125, inside its own millisecond.
    [
      {
        startAt: '2026-10-07T12:30:00.000Z',
        endAt: '2026-10-07T12:30:00.001Z',
      },
      [scriptEditorDelivery.uuid],
    ],
  ];

  for (const [scope, expected] of scopes) {
    await using runDir = await mkdtempDisposable(join(dir.path, 'run-'));
    const run = await pipeline(
      new AppleNotificationCenterSource(path, scope),
      runDir.path,
    );
    const out = join(runDir.path, 'out.sqlite');

    const loaded = counts(await run.run());

    assert.deepEqual(
      rows(out, 'SELECT id FROM notifications ORDER BY deliveredAt').map(
        ({ id }) => id,
      ),
      expected,
    );
    assert.deepEqual(loaded.apps, { count: 3, deleted: 0 });
    assert.deepEqual(loaded.categories, { count: 2, deleted: 0 });
  }
});

test('a store that stops being readable fails every stream, naming Full Disk Access, and keeps what loaded', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  // chmod stands in for macOS withholding Full Disk Access: SQLite reports
  // CANTOPEN here and AUTH under a privacy denial, and both are unavailable.
  await chmod(path, 0o000);

  try {
    await assert.rejects(run.run(), (error) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.errors.length, 4);
      for (const cause of error.errors) {
        assert.ok(cause instanceof NotificationCenterUnavailableError);
        assert.match(cause.message, /Full Disk Access/);
        assert.ok(cause.message.includes(path));
      }
      return true;
    });
  } finally {
    await chmod(path, 0o644);
  }

  assert.equal(rows(out, 'SELECT count(*) AS n FROM notifications')[0]?.n, 3);
  assert.deepEqual(counts(await run.run()), unchanged);
});

test('a store missing a column this reader reads fails every stream by name and keeps what loaded', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  const out = join(dir.path, 'out.sqlite');
  await run.run();
  {
    using store = new DatabaseSync(path);
    store.exec('ALTER TABLE record DROP COLUMN style');
  }

  await assert.rejects(run.run(), (error) => {
    assert.ok(error instanceof PipelineError);
    assert.equal(error.errors.length, 4);
    for (const cause of error.errors) {
      assert.ok(cause instanceof NotificationCenterSchemaError);
      assert.match(cause.message, /record\.style/);
    }
    return true;
  });

  assert.equal(rows(out, 'SELECT count(*) AS n FROM notifications')[0]?.n, 3);
  assert.equal(rows(out, 'SELECT count(*) AS n FROM apps')[0]?.n, 3);
});

test('a Notification Center watch loads each commit while usernoted keeps its store open', async () => {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-'),
  );
  const path = join(dir.path, 'db');
  notificationCenterFixture(path);
  const run = await pipeline(new AppleNotificationCenterSource(path), dir.path);
  // usernoted holds its connection, and so its WAL, open the whole time.
  using usernoted = new ScratchNotificationCenter(path, { existing: true });
  const controller = new AbortController();
  const batches: Record<string, { count: number; deleted: number }>[] = [];

  for await (const { outcomes } of run.watch({
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(counts(outcomes));
    if (batches.length === 1)
      deliver(usernoted, {
        ...scriptEditorDelivery,
        recId: 4,
        uuid: '4E000000-0000-4000-8000-000000000004',
        delivered: appleTime('2026-10-07T14:00:00.000Z'),
      });
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  assert.deepEqual(batches, [
    {
      notifications: { count: 3, deleted: 0 },
      apps: { count: 3, deleted: 0 },
      categories: { count: 2, deleted: 0 },
      categoryActions: { count: 2, deleted: 0 },
    },
    { ...unchanged, notifications: { count: 1, deleted: 0 } },
  ]);
});

test('this Mac’s Notification Center loads every notification and app it holds, ids as Biome writes them', async (t) => {
  if (process.platform !== 'darwin')
    return t.skip('Notification Center requires macOS');
  await using dir = await mkdtempDisposable(
    join(tmpdir(), 'elt-notes-center-live-'),
  );
  const out = join(dir.path, 'out.sqlite');

  try {
    await (await pipeline(new AppleNotificationCenterSource(), dir.path)).run();
  } catch (error) {
    if (
      error instanceof PipelineError &&
      error.errors.every(
        (cause) => cause instanceof NotificationCenterUnavailableError,
      )
    )
      return t.skip('no Full Disk Access to the Notification Center store');
    throw error;
  }

  // Counted, never printed: these are the user's own notifications. usernoted
  // delivers and withdraws by the minute, so notifications are checked by
  // shape; apps, which change rarely, by count.
  const loaded = (sql: string) => Number(rows(out, sql)[0]?.n);
  const stored = (sql: string) =>
    Number(rows(notificationCenterStorePath, sql)[0]?.n);
  assert.equal(
    loaded('SELECT count(*) AS n FROM apps'),
    stored('SELECT count(*) AS n FROM app'),
  );
  if (loaded('SELECT count(*) AS n FROM notifications') === 0)
    return t.skip('Notification Center holds no notification to check');
  assert.equal(
    loaded(
      "SELECT count(*) AS n FROM notifications WHERE id NOT GLOB '[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]-[0-9A-F][0-9A-F][0-9A-F][0-9A-F]-[0-9A-F][0-9A-F][0-9A-F][0-9A-F]-[0-9A-F][0-9A-F][0-9A-F][0-9A-F]-[0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F][0-9A-F]'",
    ),
    0,
  );
  // Every interruption level on this Mac is one the reader names.
  assert.equal(
    loaded(
      "SELECT count(*) AS n FROM notifications WHERE interruptionLevel IS NULL AND json_extract(payload, '$.req.intrp') IS NOT NULL",
    ),
    0,
  );
  // Every archive usernoted nests decodes where it sits, rather than loading
  // as Base64: the app's userInfo and the communication context.
  assert.equal(
    loaded(
      "SELECT count(*) AS n FROM notifications WHERE (userInfo IS NOT NULL AND json_type(userInfo) <> 'object') OR json_type(payload, '$.req.usda') = 'text' OR json_type(payload, '$.req.uncc') = 'text'",
    ),
    0,
  );
});
