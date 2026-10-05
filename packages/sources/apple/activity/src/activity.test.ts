import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { crc32 } from 'node:zlib';

import {
  Connection,
  Copy,
  Pipeline,
  PipelineError,
  type Source,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';

import { AppleActivitySource } from './apple-activity-source.ts';

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One Apple source loaded as the hosts load it: every stream incrementally
// into raw_<stream> of one SQLite file, read through its documented
// <snake_stream> view.
async function appleImport(source: Source, directory: string) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const { streams } = await source.discover();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'apple',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'checkpoints.sqlite'),
        }),
        steps: streams.map(
          (stream) =>
            new Copy(
              stream,
              destination
                .table(`raw_${stream.name}`)
                .withReaderView(snake(stream.name)),
              {
                id: stream.name,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
              },
            ),
        ),
      }),
    ],
  });
  installSQLiteCatalog({ path });
  return {
    load: async () =>
      Object.fromEntries(
        (await pipeline.run()).map(({ copy, count, deleted }) => [
          copy.from.name,
          { count, deleted },
        ]),
      ),
    read: (sql: string) => {
      using database = new DatabaseSync(path, { readOnly: true });
      return database
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    },
  };
}

// The protobuf wire format, as Biome writes its payloads.
type Field =
  | readonly [number, 'varint', number]
  | readonly [number, 'double', number]
  | readonly [number, 'string', string]
  | readonly [number, 'bytes', Uint8Array]
  | readonly [number, 'message', readonly Field[]];

function protobuf(fields: readonly Field[]): Uint8Array {
  const out: number[] = [];
  const varint = (value: number) => {
    let rest = BigInt(value);
    do {
      const byte = Number(rest & 0x7fn);
      rest >>= 7n;
      out.push(rest === 0n ? byte : byte | 0x80);
    } while (rest !== 0n);
  };
  const delimited = (number: number, bytes: Uint8Array) => {
    varint((number << 3) | 2);
    varint(bytes.length);
    out.push(...bytes);
  };
  for (const [number, kind, value] of fields) {
    if (kind === 'varint') {
      varint(number << 3);
      varint(value);
    } else if (kind === 'double') {
      varint((number << 3) | 1);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value, true);
      out.push(...bytes);
    } else if (kind === 'string')
      delimited(number, new TextEncoder().encode(value));
    else if (kind === 'bytes') delimited(number, value);
    else delimited(number, protobuf(value));
  }
  return new Uint8Array(out);
}

const appleEpoch = Date.UTC(2001, 0, 1);
const appleSeconds = (at: Date) => (at.getTime() - appleEpoch) / 1000;
const unixSeconds = (at: Date) => at.getTime() / 1000;

// A record as Biome keeps it: written, deleted (zero-filled in place),
// written-but-zeroed (a phantom slot whose checksum fails), or an empty slot.
type Slot = {
  readonly at: Date;
  readonly payload: Uint8Array;
  readonly state?: 'written' | 'deleted' | 'phantom' | 'empty';
};

// A SEGB v2 segment as Biome preallocates it: header, records from byte 32
// each led by its CRC-32 and an int32, and one 16-byte trailer slot per
// record counted back from the end of the file.
function segb(slots: readonly Slot[]): Uint8Array {
  const body: number[] = [];
  const trailer: { end: number; state: number; at: Date }[] = [];
  for (const { at, payload, state = 'written' } of slots) {
    if (state === 'empty') {
      trailer.push({ end: body.length, state: 4, at });
      continue;
    }
    const entry = new Uint8Array(8 + payload.length);
    const view = new DataView(entry.buffer);
    if (state === 'written') {
      view.setUint32(0, crc32(payload), true);
      view.setInt32(4, 1, true);
      entry.set(payload, 8);
    }
    body.push(...entry);
    trailer.push({ end: body.length, state: state === 'deleted' ? 3 : 1, at });
    while (body.length % 4 !== 0) body.push(0);
  }
  const size = 4096;
  const file = new Uint8Array(size);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode('SEGB'), 0);
  view.setInt32(4, slots.length, true);
  view.setFloat64(8, appleSeconds(slots[0]?.at ?? new Date()), true);
  view.setInt32(16, 10, true);
  file.set(body, 32);
  trailer.forEach(({ end, state, at }, slot) => {
    const offset = size - 16 * (slot + 1);
    view.setInt32(offset, end, true);
    view.setInt32(offset + 4, state, true);
    view.setFloat64(offset + 8, appleSeconds(at), true);
  });
  return file;
}

async function writeSegment(
  root: string,
  stream: string,
  origin: string,
  name: string,
  slots: readonly Slot[],
) {
  const directory = join(
    root,
    'Biome/streams/restricted',
    stream,
    origin === 'local' ? 'local' : join('remote', origin),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), segb(slots));
}

const execute = promisify(execFile);

// A binary property list, as knowledgeC and Biome embed them.
async function binaryPlist(root: string, xml: string): Promise<Uint8Array> {
  const path = join(root, `${crypto.randomUUID()}.plist`);
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml}</plist>`,
  );
  await execute('/usr/bin/plutil', ['-convert', 'binary1', path]);
  try {
    return new Uint8Array(await readFile(path));
  } finally {
    await rm(path);
  }
}

// knowledgeC's own tables on macOS 27; ZSTRUCTUREDMETADATA keeps only the
// columns this connector reads of its nearly three hundred.
const knowledgeSchema = `
CREATE TABLE ZOBJECT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZUUIDHASH INTEGER, ZEVENT INTEGER, ZSOURCE INTEGER, ZCATEGORYTYPE INTEGER, ZINTEGERVALUE INTEGER, ZCOMPATIBILITYVERSION INTEGER, ZENDDAYOFWEEK INTEGER, ZENDSECONDOFDAY INTEGER, ZHASCUSTOMMETADATA INTEGER, ZHASSTRUCTUREDMETADATA INTEGER, ZSECONDSFROMGMT INTEGER, ZSHOULDSYNC INTEGER, ZSTARTDAYOFWEEK INTEGER, ZSTARTSECONDOFDAY INTEGER, ZVALUECLASS INTEGER, ZVALUEINTEGER INTEGER, ZVALUETYPECODE INTEGER, ZSTRUCTUREDMETADATA INTEGER, ZVALUE INTEGER, Z9_VALUE INTEGER, ZIDENTIFIERTYPE INTEGER, ZQUANTITYTYPE INTEGER, ZCREATIONDATE TIMESTAMP, ZLOCALCREATIONDATE TIMESTAMP, ZCONFIDENCE FLOAT, ZENDDATE TIMESTAMP, ZSTARTDATE TIMESTAMP, ZVALUEDOUBLE FLOAT, ZDOUBLEVALUE FLOAT, ZUUID VARCHAR, ZSTREAMNAME VARCHAR, ZVALUESTRING VARCHAR, ZSTRING VARCHAR, ZMETADATA BLOB );
CREATE TABLE ZSTRUCTUREDMETADATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, Z_DKINTENTMETADATAKEY__DIRECTION INTEGER, Z_DKINTENTMETADATAKEY__DONATEDBYSIRI INTEGER, Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS INTEGER, Z_DKINTENTMETADATAKEY__INTENTTYPE INTEGER, Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER VARCHAR, Z_DKINTENTMETADATAKEY__INTENTCLASS VARCHAR, Z_DKINTENTMETADATAKEY__INTENTVERB VARCHAR, Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER VARCHAR, Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS VARCHAR, Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION BLOB, Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD VARCHAR, Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO BLOB, ZMETADATAHASH VARCHAR );
CREATE TABLE ZSOURCE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZUSERID INTEGER, ZBUNDLEID VARCHAR, ZDEVICEID VARCHAR, ZGROUPID VARCHAR, ZINTENTID VARCHAR, ZITEMID VARCHAR, ZSOURCEID VARCHAR );
`;

// Biome's device list on macOS 27.
const devicesSchema = `CREATE TABLE DevicePeer (
 device_identifier STRING NOT NULL,
 ids_device_identifier STRING,
 me BOOLEAN,
 name STRING,
 model STRING,
 platform INTEGER,
 last_sync_date INTEGER,
 protocol_version INTEGER NOT NULL
);`;

type Event = {
  readonly id: string;
  readonly stream: string;
  readonly start: Date;
  readonly end: Date;
  readonly value?: { readonly string?: string; readonly integer?: number };
  readonly metadata?: Readonly<Record<string, string | number | Uint8Array>>;
  readonly source?: Readonly<Record<string, string>>;
};

function insertEvent(knowledge: DatabaseSync, event: Event) {
  const metadata =
    event.metadata === undefined
      ? null
      : Number(
          knowledge
            .prepare(
              `INSERT INTO ZSTRUCTUREDMETADATA (${Object.keys(event.metadata).join(', ')}) VALUES (${Object.keys(
                event.metadata,
              )
                .map(() => '?')
                .join(', ')})`,
            )
            .run(...Object.values(event.metadata)).lastInsertRowid,
        );
  const source =
    event.source === undefined
      ? null
      : Number(
          knowledge
            .prepare(
              `INSERT INTO ZSOURCE (${Object.keys(event.source).join(', ')}) VALUES (${Object.keys(
                event.source,
              )
                .map(() => '?')
                .join(', ')})`,
            )
            .run(...Object.values(event.source)).lastInsertRowid,
        );
  knowledge
    .prepare(
      'INSERT INTO ZOBJECT (ZUUID, ZSTREAMNAME, ZSTARTDATE, ZENDDATE, ZCREATIONDATE, ZSECONDSFROMGMT, ZVALUESTRING, ZVALUEINTEGER, ZSTRUCTUREDMETADATA, ZSOURCE) VALUES (?, ?, ?, ?, ?, 10800, ?, ?, ?, ?)',
    )
    .run(
      event.id,
      event.stream,
      appleSeconds(event.start),
      appleSeconds(event.end),
      appleSeconds(event.end) + 0.25,
      event.value?.string ?? null,
      event.value?.integer ?? null,
      metadata,
      source,
    );
}

// An empty activity store: Biome's folders and device list, and knowledgeC,
// both keeping their WAL as macOS does.
async function activityFixture(root: string) {
  await mkdir(join(root, 'Biome/streams/restricted'), { recursive: true });
  await mkdir(join(root, 'Biome/sync'), { recursive: true });
  {
    using knowledge = new DatabaseSync(join(root, 'knowledgeC.db'));
    knowledge.exec('PRAGMA journal_mode = WAL');
    knowledge.exec(knowledgeSchema);
  }
  {
    using devices = new DatabaseSync(join(root, 'Biome/sync/sync.db'));
    devices.exec('PRAGMA journal_mode = WAL');
    devices.exec(devicesSchema);
    devices
      .prepare('INSERT INTO DevicePeer VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('MAC-1', null, 1, '', '26A428', 3, null, 1);
    devices
      .prepare('INSERT INTO DevicePeer VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('PHONE-1', null, 0, '', '23G90', 2, 1_790_000_000, 1);
  }
  return {
    biome: join(root, 'Biome'),
    knowledge: join(root, 'knowledgeC.db'),
  };
}

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

test('Activity reads every Biome stream, knowledgeC and the device list as documented views', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'activity-'));
  const location = await activityFixture(scratch.path);
  const at = new Date('2026-10-01T09:00:00.000Z');
  const root = scratch.path;
  const segment = (
    stream: string,
    payload: readonly Field[],
    origin = 'local',
  ) =>
    writeSegment(root, stream, origin, '812000000000000', [
      { at, payload: protobuf(payload) },
    ]);
  const archive = await binaryPlist(
    root,
    '<dict><key>intent</key><string>INSendMessageIntent</string></dict>',
  );
  await writeSegment(root, 'App.InFocus', 'local', '812000000000000', [
    {
      at,
      payload: protobuf([
        [2, 'varint', 1],
        [3, 'varint', 1],
        [4, 'double', appleSeconds(at)],
        [6, 'string', 'com.apple.Safari'],
        [9, 'string', '27.0'],
        [10, 'string', '21627.1'],
        [11, 'varint', 1],
        [12, 'varint', 1],
        [13, 'varint', 0],
      ]),
    },
    // Biome zero-fills a deleted record, and leaves some written slots zeroed.
    { at, payload: protobuf([[6, 'string', 'gone']]), state: 'deleted' },
    { at, payload: protobuf([[6, 'string', 'zeroed']]), state: 'phantom' },
    { at, payload: new Uint8Array(), state: 'empty' },
  ]);
  await segment(
    'App.InFocus',
    [
      [1, 'string', 'com.apple.SpringBoard.transitionReason.homescreen'],
      [2, 'varint', 1],
      [3, 'varint', 0],
      [4, 'double', appleSeconds(at)],
      [6, 'string', 'net.whatsapp.WhatsApp'],
      [9, 'string', ''],
      [13, 'varint', 1],
    ],
    'PHONE-1',
  );
  await segment('ScreenTime.AppUsage', [
    [1, 'varint', 1],
    [2, 'double', unixSeconds(at)],
    [3, 'string', 'com.apple.Safari'],
    [5, 'varint', 1],
  ]);
  await segment('App.MenuItem', [[1, 'string', 'com.apple.Notes']]);
  await segment('App.Intent', [
    [1, 'double', appleSeconds(at) - 5],
    [2, 'string', 'net.whatsapp.WhatsApp'],
    [3, 'string', 'intents'],
    [4, 'string', 'INSendMessageIntent'],
    [5, 'string', 'SendMessage'],
    [6, 'varint', 1],
    [7, 'varint', 4],
    [8, 'bytes', archive],
    [9, 'string', 'ITEM-1'],
    [10, 'varint', 0],
    [11, 'varint', 3],
    [12, 'string', 'conversation-1'],
  ]);
  await segment('App.WebUsage', [
    [1, 'string', 'VISIT-1'],
    [2, 'double', appleSeconds(at)],
    [3, 'varint', 2],
    [4, 'string', 'https://example.com/page'],
    [5, 'string', 'example.com'],
    [6, 'string', 'com.apple.Safari'],
    [8, 'varint', 1],
  ]);
  await segment('Safari.Navigations', [
    [1, 'string', 'example.com'],
    [2, 'double', unixSeconds(new Date('2026-10-01T09:30:00.000Z'))],
    [3, 'varint', 1],
    [5, 'string', 'AE'],
    [8, 'string', 'https://example.com/page'],
  ]);
  await segment('App.DocumentInteraction', [
    [1, 'varint', 1],
    [
      2,
      'message',
      [
        [1, 'string', '/Users/someone/Documents/report.pdf'],
        [2, 'bytes', new Uint8Array([98, 111, 111, 107])],
      ],
    ],
    [3, 'string', 'com.adobe.pdf'],
    [
      4,
      'message',
      [
        [1, 'string', 'com.apple.Preview'],
        [2, 'string', 'file:///System/Applications/Preview.app/'],
      ],
    ],
  ]);
  await segment('App.MediaUsage', [
    [1, 'varint', 1],
    [2, 'string', 'com.apple.Music'],
    [5, 'varint', 1],
    [6, 'double', unixSeconds(at)],
    [8, 'string', 'PLAY-1'],
  ]);
  await segment('Media.NowPlaying', [
    [2, 'double', appleSeconds(at)],
    [3, 'varint', 1],
    [4, 'string', ''],
    [5, 'string', 'An Artist'],
    [6, 'varint', 4_294_967_295],
    [8, 'string', 'A Song'],
    [13, 'varint', 0],
    [
      14,
      'message',
      [
        [1, 'varint', 4],
        [2, 'varint', 2],
        [3, 'string', 'Speaker'],
      ],
    ],
    [15, 'string', 'com.apple.Music'],
  ]);
  await segment('UserFocus.ComputedMode', [
    [1, 'string', 'MODE-1'],
    [2, 'varint', 1],
    [3, 'varint', 3],
    [4, 'varint', 6],
    [5, 'varint', 1],
    [6, 'string', 'com.apple.focus.work'],
  ]);
  await segment('UserFocus.InferredMode', [
    [1, 'double', appleSeconds(at)],
    [2, 'string', 'MODE-1'],
    [3, 'varint', 1],
    [5, 'varint', 1],
    [6, 'varint', 1],
    [7, 'string', 'SUGGESTION-1'],
    [9, 'varint', 1],
    [10, 'double', 0.8],
    [12, 'varint', 2],
    [13, 'varint', 0],
    [14, 'string', 'Work'],
  ]);
  await segment('Notification.Usage', [
    [2, 'double', appleSeconds(at)],
    [3, 'varint', 1],
    [4, 'string', 'com.apple.mail'],
    [5, 'string', 'NOTE-1'],
  ]);
  await segment('Notification.Delivery', [
    [1, 'string', 'REQUEST-1'],
    [2, 'string', 'com.apple.mail'],
    [3, 'double', unixSeconds(at) - 60],
  ]);
  await segment('Device.Wireless.Bluetooth', [
    [1, 'string', 'AA:BB:CC:DD:EE:FF'],
    [2, 'string', 'AirPods Pro'],
    [3, 'varint', 8219],
    [4, 'varint', 1],
    [5, 'varint', 21],
    [6, 'varint', 80],
    [7, 'varint', 95],
    [8, 'varint', 90],
    [9, 'varint', 1],
    [10, 'varint', 1],
    [11, 'varint', 76],
  ]);
  await segment('Screenshots.Screenshot', [
    [
      1,
      'message',
      [
        [1, 'varint', 2],
        [2, 'varint', 2],
        [
          4,
          'message',
          [[1, 'string', '/Users/someone/Desktop/Screenshot.png']],
        ],
        [6, 'varint', 3],
      ],
    ],
  ]);
  const userInfo = await binaryPlist(
    root,
    '<dict><key>count</key><integer>3</integer></dict>',
  );
  {
    using knowledge = new DatabaseSync(location.knowledge);
    insertEvent(knowledge, {
      id: 'INTENT-1',
      stream: '/app/intents',
      start: at,
      end: at,
      value: { string: 'Messages' },
      metadata: {
        Z_DKINTENTMETADATAKEY__INTENTCLASS: 'INSendMessageIntent',
        Z_DKINTENTMETADATAKEY__INTENTVERB: 'SendMessage',
        Z_DKINTENTMETADATAKEY__INTENTTYPE: 1,
        Z_DKINTENTMETADATAKEY__INTENTHANDLINGSTATUS: 3,
        Z_DKINTENTMETADATAKEY__DIRECTION: 1,
        Z_DKINTENTMETADATAKEY__DONATEDBYSIRI: 0,
        Z_DKINTENTMETADATAKEY__INTERACTIONIDENTIFIER: 'INTERACTION-1',
        Z_DKINTENTMETADATAKEY__DERIVEDINTENTIDENTIFIER: 'DERIVED-1',
        Z_DKINTENTMETADATAKEY__RELATEDCONTACTIDENTIFIERS: 'CONTACT-1',
        Z_DKINTENTMETADATAKEY__SERIALIZEDINTERACTION: archive,
      },
      source: {
        ZBUNDLEID: 'net.whatsapp.WhatsApp',
        ZDEVICEID: 'KNOWLEDGE-DEVICE',
        ZITEMID: 'INTERACTION-1',
        ZGROUPID: 'conversation-1',
        ZSOURCEID: 'intents',
      },
    });
    insertEvent(knowledge, {
      id: 'BACKLIGHT-1',
      stream: '/display/isBacklit',
      start: at,
      end: new Date(at.getTime() + 600_000),
      value: { integer: 1 },
    });
    insertEvent(knowledge, {
      id: 'SIGNAL-1',
      stream: '/discoverability/signals',
      start: at,
      end: at,
      value: { string: 'com.apple.spotlight.invoked' },
      metadata: {
        Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__OSBUILD: '26A428',
        Z_DKDISCOVERABILITYSIGNALSMETADATAKEY__USERINFO: userInfo,
      },
      source: { ZBUNDLEID: 'com.apple.Spotlight' },
    });
    // Another stream's events, which no stream here reads.
    insertEvent(knowledge, {
      id: 'USAGE-1',
      stream: '/app/usage',
      start: at,
      end: at,
      value: { string: 'com.apple.Safari' },
    });
  }
  const activity = await appleImport(
    new AppleActivitySource(location),
    join(root, 'import'),
  );

  const loaded = await activity.load();

  assert.deepEqual(
    Object.fromEntries(
      Object.entries(loaded).map(([name, { count }]) => [name, count]),
    ),
    {
      appFocus: 2,
      screenTimeAppUsage: 1,
      appMenuItems: 1,
      appIntents: 1,
      webUsage: 1,
      safariNavigations: 1,
      documentInteractions: 1,
      mediaUsage: 1,
      nowPlaying: 1,
      focusModes: 1,
      focusSuggestions: 1,
      notificationUsage: 1,
      notificationDeliveries: 1,
      bluetoothConnections: 1,
      screenshots: 1,
      knowledgeIntents: 1,
      displayBacklight: 1,
      discoverabilitySignals: 1,
      devices: 2,
    },
  );
  const recordedAt = at.toISOString();
  const address = (origin = 'local') => ({
    origin,
    segment: '812000000000000',
    slot: 0,
    recordedAt,
  });
  const view = (name: string) =>
    activity
      .read(`SELECT * FROM ${name} ORDER BY 1, 2, 3`)
      .map(({ payload: _, loaded_at: __, ...row }) => row);
  assert.deepEqual(view('app_focus'), [
    {
      ...address('PHONE-1'),
      started: 0,
      occurredAt: recordedAt,
      bundleId: 'net.whatsapp.WhatsApp',
      launchReason: 'com.apple.SpringBoard.transitionReason.homescreen',
      eventType: 1,
      shortVersion: null,
      bundleVersion: null,
      platform: null,
      nativeArchitecture: null,
      displayType: 1,
    },
    {
      ...address(),
      started: 1,
      occurredAt: recordedAt,
      bundleId: 'com.apple.Safari',
      launchReason: null,
      eventType: 1,
      shortVersion: '27.0',
      bundleVersion: '21627.1',
      platform: 1,
      nativeArchitecture: 1,
      displayType: 0,
    },
  ]);
  assert.deepEqual(
    activity.read("SELECT payload FROM app_focus WHERE origin = 'PHONE-1'")[0]
      ?.payload,
    Buffer.from(
      protobuf([
        [1, 'string', 'com.apple.SpringBoard.transitionReason.homescreen'],
        [2, 'varint', 1],
        [3, 'varint', 0],
        [4, 'double', appleSeconds(at)],
        [6, 'string', 'net.whatsapp.WhatsApp'],
        [9, 'string', ''],
        [13, 'varint', 1],
      ]),
    ).toString('base64'),
  );
  assert.deepEqual(view('screen_time_app_usage'), [
    {
      ...address(),
      started: 1,
      occurredAt: recordedAt,
      bundleId: 'com.apple.Safari',
      usageTrusted: 1,
    },
  ]);
  assert.deepEqual(view('app_menu_items'), [
    { ...address(), bundleId: 'com.apple.Notes' },
  ]);
  assert.deepEqual(view('app_intents'), [
    {
      ...address(),
      occurredAt: new Date(at.getTime() - 5000).toISOString(),
      bundleId: 'net.whatsapp.WhatsApp',
      sourceId: 'intents',
      intentClass: 'INSendMessageIntent',
      intentVerb: 'SendMessage',
      intentType: 1,
      handlingStatus: 4,
      direction: 3,
      donatedBySiri: 0,
      itemId: 'ITEM-1',
      groupId: 'conversation-1',
      interaction: '{"intent":"INSendMessageIntent"}',
    },
  ]);
  assert.deepEqual(view('web_usage'), [
    {
      ...address(),
      usageId: 'VISIT-1',
      occurredAt: recordedAt,
      usageState: 2,
      url: 'https://example.com/page',
      domain: 'example.com',
      bundleId: 'com.apple.Safari',
      usageTrusted: 1,
      safariProfileId: null,
    },
  ]);
  assert.deepEqual(view('safari_navigations'), [
    {
      ...address(),
      host: 'example.com',
      url: 'https://example.com/page',
      countryCode: 'AE',
      periodEndsAt: '2026-10-01T09:30:00.000Z',
    },
  ]);
  assert.deepEqual(view('document_interactions'), [
    {
      ...address(),
      interactionType: 1,
      path: '/Users/someone/Documents/report.pdf',
      contentType: 'com.adobe.pdf',
      bundleId: 'com.apple.Preview',
      appUrl: 'file:///System/Applications/Preview.app/',
    },
  ]);
  assert.deepEqual(view('media_usage'), [
    {
      ...address(),
      usageId: 'PLAY-1',
      started: 1,
      occurredAt: recordedAt,
      bundleId: 'com.apple.Music',
      usageTrusted: 1,
    },
  ]);
  assert.deepEqual(view('now_playing'), [
    {
      ...address(),
      occurredAt: recordedAt,
      playbackState: 1,
      title: 'A Song',
      artist: 'An Artist',
      album: null,
      durationSeconds: null,
      mediaType: null,
      airPlayVideo: 0,
      bundleId: 'com.apple.Music',
      outputDeviceIds: '["Speaker"]',
    },
  ]);
  assert.deepEqual(view('focus_modes'), [
    {
      ...address(),
      modeId: 'MODE-1',
      semanticModeId: 'com.apple.focus.work',
      started: 1,
      semanticType: 6,
      updateReason: 3,
      updateSource: 1,
    },
  ]);
  assert.deepEqual(view('focus_suggestions'), [
    {
      ...address(),
      suggestionId: 'SUGGESTION-1',
      occurredAt: recordedAt,
      started: 1,
      modeId: 'MODE-1',
      modeName: 'Work',
      modeType: 2,
      origin: 1,
      automationEnabled: 1,
      uiLocation: 1,
      confidence: 0.8,
      shouldSuggestTriggers: 0,
      triggers: null,
    },
  ]);
  assert.deepEqual(view('notification_usage'), [
    {
      ...address(),
      notificationId: 'NOTE-1',
      occurredAt: recordedAt,
      usageType: 1,
      bundleId: 'com.apple.mail',
    },
  ]);
  assert.deepEqual(view('notification_deliveries'), [
    {
      ...address(),
      requestId: 'REQUEST-1',
      bundleId: 'com.apple.mail',
      occurredAt: new Date(at.getTime() - 60_000).toISOString(),
    },
  ]);
  assert.deepEqual(view('bluetooth_connections'), [
    {
      ...address(),
      address: 'AA:BB:CC:DD:EE:FF',
      deviceName: 'AirPods Pro',
      connected: 1,
      vendorId: 76,
      productId: 8219,
      deviceType: 21,
      appleAudioDevice: 1,
      userWearing: 1,
      batteryCase: 80,
      batteryLeft: 90,
      batteryRight: 95,
    },
  ]);
  assert.deepEqual(view('screenshots'), [
    {
      ...address(),
      path: '/Users/someone/Desktop/Screenshot.png',
      screenshotSource: 2,
      screenshotLocation: 2,
      screenshotStyle: 3,
    },
  ]);
  const event = {
    startedAt: recordedAt,
    createdAt: new Date(at.getTime() + 250).toISOString(),
    utcOffsetSeconds: 10800,
  };
  assert.deepEqual(view('knowledge_intents'), [
    {
      id: 'INTENT-1',
      ...event,
      endedAt: recordedAt,
      category: 'Messages',
      bundleId: 'net.whatsapp.WhatsApp',
      deviceId: 'KNOWLEDGE-DEVICE',
      itemId: 'INTERACTION-1',
      groupId: 'conversation-1',
      intentClass: 'INSendMessageIntent',
      intentVerb: 'SendMessage',
      intentType: 1,
      handlingStatus: 3,
      direction: 1,
      donatedBySiri: 0,
      interactionId: 'INTERACTION-1',
      derivedIntentId: 'DERIVED-1',
      relatedContactIds: 'CONTACT-1',
      interaction: '{"intent":"INSendMessageIntent"}',
    },
  ]);
  assert.deepEqual(view('display_backlight'), [
    {
      id: 'BACKLIGHT-1',
      ...event,
      endedAt: new Date(at.getTime() + 600_000).toISOString(),
      createdAt: new Date(at.getTime() + 600_250).toISOString(),
      backlit: 1,
    },
  ]);
  assert.deepEqual(view('discoverability_signals'), [
    {
      id: 'SIGNAL-1',
      ...event,
      endedAt: recordedAt,
      signal: 'com.apple.spotlight.invoked',
      bundleId: 'com.apple.Spotlight',
      osBuild: '26A428',
      userInfo: '{"count":3}',
    },
  ]);
  assert.deepEqual(view('devices'), [
    {
      deviceId: 'MAC-1',
      thisMac: 1,
      name: null,
      model: '26A428',
      platform: 3,
      lastSyncedAt: null,
    },
    {
      deviceId: 'PHONE-1',
      thisMac: 0,
      name: null,
      model: '23G90',
      platform: 2,
      lastSyncedAt: '2026-09-21T14:13:20.000Z',
    },
  ]);
});

test('Activity keeps the rows of records macOS expired, deletes what was removed within their age, and rereads only changed segments', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'activity-'));
  const location = await activityFixture(scratch.path);
  const root = scratch.path;
  const focus = (
    bundleId: string,
    days: number,
    state?: 'written' | 'deleted',
  ): Slot => ({
    at: daysAgo(days),
    payload: protobuf([
      [2, 'varint', 1],
      [3, 'varint', 1],
      [4, 'double', appleSeconds(daysAgo(days))],
      [6, 'string', bundleId],
    ]),
    state,
  });
  const delivery = (
    id: string,
    days: number,
    state: 'written' | 'deleted',
  ): Slot => ({
    at: daysAgo(days),
    payload: protobuf([
      [1, 'string', id],
      [2, 'string', 'com.apple.mail'],
      [3, 'double', unixSeconds(daysAgo(days))],
    ]),
    state,
  });
  const recent = focus('com.apple.Notes', 1);
  const local = (states: readonly ('written' | 'deleted')[]) =>
    writeSegment(root, 'App.InFocus', 'local', '810000000000000', [
      focus('com.apple.Mail', 35, states[0]),
      focus('com.apple.Safari', 10, states[1]),
      recent,
    ]);
  const deliveries = (states: readonly ('written' | 'deleted')[]) =>
    writeSegment(root, 'Notification.Delivery', 'local', '810000000000000', [
      delivery('OLD', 4, states[0] ?? 'written'),
      delivery('NEW', 1, states[1] ?? 'written'),
    ]);
  await local(['written', 'written']);
  await writeSegment(root, 'App.InFocus', 'PHONE-1', '809000000000000', [
    focus('com.burbn.instagram', 30),
  ]);
  await deliveries(['written', 'written']);
  {
    using knowledge = new DatabaseSync(location.knowledge);
    for (const [id, days] of [
      ['OLD', 30],
      ['NEW', 2],
    ] as const)
      insertEvent(knowledge, {
        id,
        stream: '/display/isBacklit',
        start: daysAgo(days),
        end: daysAgo(days),
        value: { integer: 1 },
      });
  }
  const activity = await appleImport(
    new AppleActivitySource(location),
    join(root, 'import'),
  );
  const changed = (loaded: Awaited<ReturnType<typeof activity.load>>) =>
    Object.fromEntries(
      Object.entries(loaded).filter(
        ([, { count, deleted }]) => count > 0 || deleted > 0,
      ),
    );
  const bundles = () =>
    activity
      .read('SELECT "bundleId" FROM app_focus ORDER BY "bundleId"')
      .map(({ bundleId }) => bundleId);
  const first = changed(await activity.load());

  // macOS prunes the 35-day-old focus record and the 4-day-old delivery past
  // their streams' ages, removes the phone's emptied segment and drops the
  // month-old backlight span; the newer ones were deleted within their age.
  await local(['deleted', 'deleted']);
  await deliveries(['deleted', 'deleted']);
  await rm(join(root, 'Biome/streams/restricted/App.InFocus/remote'), {
    recursive: true,
  });
  {
    using knowledge = new DatabaseSync(location.knowledge);
    knowledge.exec(
      "DELETE FROM ZOBJECT WHERE ZSTREAMNAME = '/display/isBacklit'",
    );
  }
  const second = changed(await activity.load());
  const third = changed(await activity.load());

  // A segment whose trailer did not change is not read again, even when its
  // bytes did.
  const path = join(
    root,
    'Biome/streams/restricted/App.InFocus/local/810000000000000',
  );
  const bytes = await readFile(path);
  const notes = bytes.indexOf(Buffer.from('com.apple.Notes'));
  bytes[notes] = (bytes[notes] ?? 0) ^ 0xff;
  await writeFile(path, bytes);
  const fourth = changed(await activity.load());

  assert.deepEqual(first, {
    appFocus: { count: 4, deleted: 0 },
    notificationDeliveries: { count: 2, deleted: 0 },
    displayBacklight: { count: 2, deleted: 0 },
    devices: { count: 2, deleted: 0 },
  });
  assert.deepEqual(second, {
    appFocus: { count: 0, deleted: 1 },
    notificationDeliveries: { count: 0, deleted: 1 },
    displayBacklight: { count: 0, deleted: 1 },
  });
  assert.deepEqual(third, {});
  assert.deepEqual(fourth, {});
  assert.deepEqual(bundles(), [
    'com.apple.Mail',
    'com.apple.Notes',
    'com.burbn.instagram',
  ]);
  assert.deepEqual(
    activity
      .read('SELECT "requestId" FROM notification_deliveries')
      .map(({ requestId }) => requestId),
    ['OLD'],
  );
  assert.deepEqual(
    activity.read('SELECT id FROM display_backlight').map(({ id }) => id),
    ['OLD'],
  );
});

test('Activity names Full Disk Access for unreadable Biome folders, refuses an unknown knowledgeC layout, and fails only their streams', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'activity-'));
  const location = await activityFixture(scratch.path);
  await writeSegment(scratch.path, 'App.MenuItem', 'local', '810000000000000', [
    { at: daysAgo(1), payload: protobuf([[1, 'string', 'com.apple.Notes']]) },
  ]);
  const activity = await appleImport(
    new AppleActivitySource(location),
    join(scratch.path, 'import'),
  );
  await activity.load();
  const restricted = join(scratch.path, 'Biome/streams/restricted');
  {
    using knowledge = new DatabaseSync(location.knowledge);
    knowledge.exec('ALTER TABLE ZOBJECT DROP COLUMN ZSECONDSFROMGMT');
  }
  await chmod(restricted, 0o000);
  try {
    const failure = await activity.load().then(
      () => null,
      (error: unknown) => error,
    );

    assert.ok(failure instanceof PipelineError);
    const failed = Object.fromEntries(
      failure.results
        .filter(({ failures }) => failures.length > 0)
        .map(({ copy, failures }) => [
          copy.configuration.stream.name,
          String(failures[0]?.error),
        ]),
    );
    assert.equal(Object.keys(failed).length, 18);
    assert.equal(failed.devices, undefined);
    assert.match(
      failed.appMenuItems ?? '',
      /restricted cannot be read\. Allow the process that runs the export Full Disk Access/,
    );
    assert.match(
      failed.displayBacklight ?? '',
      /missing ZOBJECT\.ZSECONDSFROMGMT/,
    );
    assert.deepEqual(activity.read('SELECT "bundleId" FROM app_menu_items'), [
      { bundleId: 'com.apple.Notes' },
    ]);
  } finally {
    await chmod(restricted, 0o755);
  }
});

test('an Activity watch wakes only the streams whose segments or database changed', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'activity-'));
  const location = await activityFixture(scratch.path);
  const record = (bundleId: string, days: number): Slot => ({
    at: daysAgo(days),
    payload: protobuf([
      [2, 'varint', 1],
      [3, 'varint', 1],
      [4, 'double', appleSeconds(daysAgo(days))],
      [6, 'string', bundleId],
    ]),
  });
  await writeSegment(scratch.path, 'App.InFocus', 'local', '810000000000000', [
    record('com.apple.Notes', 2),
  ]);
  const source = new AppleActivitySource({ ...location, pollIntervalMs: 50 });
  // knowledgeC keeps its connection, and so its WAL, open the whole time.
  using knowledge = new DatabaseSync(location.knowledge);
  const controller = new AbortController();
  const woken: string[][] = [];

  for await (const batch of source.watch({
    streams: [source.appFocus, source.appMenuItems, source.displayBacklight],
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    woken.push(batch.map((stream) => stream.name));
    if (woken.length === 1)
      // Biome appends in place: the file keeps its size.
      await writeSegment(
        scratch.path,
        'App.InFocus',
        'local',
        '810000000000000',
        [record('com.apple.Notes', 2), record('com.apple.Safari', 1)],
      );
    else if (woken.length === 2)
      await writeSegment(
        scratch.path,
        'App.MenuItem',
        'local',
        '810000000000000',
        [
          {
            at: daysAgo(1),
            payload: protobuf([[1, 'string', 'com.apple.Notes']]),
          },
        ],
      );
    else if (woken.length === 3)
      insertEvent(knowledge, {
        id: 'NEW',
        stream: '/display/isBacklit',
        start: daysAgo(1),
        end: daysAgo(1),
        value: { integer: 0 },
      });
    else controller.abort();
  }

  assert.deepEqual(woken, [
    ['appFocus', 'appMenuItems', 'displayBacklight'],
    ['appFocus'],
    ['appMenuItems'],
    ['displayBacklight'],
  ]);
});

test('Activity reads this Mac’s activity into SQLite', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Activity requires macOS');
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'activity-live-'),
  );
  const source = new AppleActivitySource();
  const activity = await appleImport(source, scratch.path);

  const outcome = await activity.load().then(
    (loaded) => loaded,
    (error: unknown) => error,
  );
  if (
    outcome instanceof PipelineError &&
    JSON.stringify(outcome, Object.getOwnPropertyNames(outcome)).includes(
      'ActivityUnavailableError',
    )
  )
    return t.skip('no Full Disk Access to Biome and knowledgeC');
  assert.ok(!(outcome instanceof Error), String(outcome));

  // Every Mac has a device list naming itself, and records app focus.
  assert.deepEqual(
    activity.read('SELECT count(*) AS n FROM devices WHERE "thisMac" = 1'),
    [{ n: 1 }],
  );
  const focus = activity.read(
    'SELECT count(*) AS n, min("recordedAt") AS oldest FROM app_focus WHERE origin = \'local\'',
  )[0];
  assert.ok(Number(focus?.n) > 0);
  // macOS keeps app focus for 28 days.
  assert.ok(String(focus?.oldest) > daysAgo(29).toISOString());
});
