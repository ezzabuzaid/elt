import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

import type {
  AppleConnector,
  Preset,
} from '@workspace/connector-apple-connector/apple-connector';
import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory, installSQLiteCatalog } from '@workspace/elt-sqlite';

// This package's folder, which holds its manifest and presets.
const folder = fileURLToPath(new URL('..', import.meta.url));

// Activity finds Biome and knowledgeC under HOME when its module loads, so the
// connector is imported only after HOME points at the test's folder. node
// --test runs this file in its own process, so the module loads once.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: ActivityConnector } =
      await import('./activity-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Activity reads nothing through EventKit.
    return new ActivityConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

// The import the plugin makes: one pass into data.sqlite with sync history
// and catalog.
async function importActivity(
  connector: AppleConnector,
  directory: string,
): Promise<string> {
  const { connection, destination } = await connector.connection(directory, {
    connector: connector.name,
    scope: {},
    includeAttachments: false,
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog(destination);
  await new Pipeline({ connections: [connection], history }).run();
  return join(directory, 'data.sqlite');
}

// Runs a query as query-apple tells the agent to: the macOS sqlite3 shell,
// read-only, with the presets loaded through -cmd. A failing statement fails
// the test rather than reading as no rows.
function read(
  database: string,
  presets: readonly Preset[],
  sql: string,
): Record<string, unknown>[] {
  const result = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      '-cmd',
      '.timeout 30000',
      '-cmd',
      'PRAGMA temp_store = MEMORY',
      ...presets.flatMap(({ file }) => ['-cmd', `.read "${file}"`]),
      database,
      sql,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout || '[]');
}

// The names a preset's header describes, in order: the view, then each column.
const described = (preset: Preset) =>
  [...readFileSync(preset.file, 'utf8').matchAll(/^-- (\w+): /gm)].map(
    ([, name]) => name,
  );

// The protobuf wire format, as Biome writes its payloads.
type Field =
  | readonly [number, 'varint', number]
  | readonly [number, 'double', number]
  | readonly [number, 'string', string];

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
  for (const [number, kind, value] of fields) {
    if (kind === 'varint') {
      varint(number << 3);
      varint(value);
    } else if (kind === 'double') {
      varint((number << 3) | 1);
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value, true);
      out.push(...bytes);
    } else {
      const bytes = new TextEncoder().encode(value);
      varint((number << 3) | 2);
      varint(bytes.length);
      out.push(...bytes);
    }
  }
  return new Uint8Array(out);
}

const appleEpoch = Date.UTC(2001, 0, 1);
const base = Date.parse('2026-10-01T09:00:00.000Z');
// A time this many minutes after 09:00 on 2026-10-01.
const at = (minutes: number) => new Date(base + minutes * 60_000);
const appleSeconds = (minutes: number) =>
  (at(minutes).getTime() - appleEpoch) / 1000;
const unixSeconds = (minutes: number) => at(minutes).getTime() / 1000;
const iso = (minutes: number) => at(minutes).toISOString();

// A SEGB v2 segment as Biome preallocates it: header, records from byte 32
// each led by its CRC-32 and an int32, and one 16-byte trailer slot per
// record counted back from the end of the file.
function segment(records: readonly (readonly [number, Uint8Array])[]) {
  const size = 8192;
  const file = new Uint8Array(size);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode('SEGB'), 0);
  view.setInt32(4, records.length, true);
  let end = 0;
  records.forEach(([minutes, payload], slot) => {
    const entry = 32 + end;
    view.setUint32(entry, crc32(payload), true);
    view.setInt32(entry + 4, 1, true);
    file.set(payload, entry + 8);
    end += 8 + payload.length;
    const trailer = size - 16 * (slot + 1);
    view.setInt32(trailer, end, true);
    view.setInt32(trailer + 4, 1, true);
    view.setFloat64(trailer + 8, appleSeconds(minutes), true);
    end += (4 - (end % 4)) % 4;
  });
  return file;
}

function writeStream(
  home: string,
  stream: string,
  origin: string,
  records: readonly (readonly [number, Uint8Array])[],
) {
  const directory = join(
    home,
    'Library/Biome/streams/restricted',
    stream,
    origin === 'local' ? 'local' : join('remote', origin),
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '812000000000000'), segment(records));
}

// knowledgeC's own tables on macOS 27; ZSTRUCTUREDMETADATA keeps only the
// columns the connector reads of its nearly three hundred.
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

const focus = (bundleId: string, started: boolean, minutes: number) =>
  protobuf([
    [2, 'varint', 1],
    [3, 'varint', started ? 1 : 0],
    [4, 'double', appleSeconds(minutes)],
    [6, 'string', bundleId],
  ]);

const bluetooth = (address: string, connected: boolean) =>
  protobuf([
    [1, 'string', address],
    [2, 'string', `Device ${address.slice(0, 2)}`],
    [3, 'varint', 8219],
    [4, 'varint', connected ? 1 : 0],
    [5, 'varint', 21],
    [6, 'varint', 0],
    [7, 'varint', 0],
    [8, 'varint', 0],
    [9, 'varint', 1],
    [10, 'varint', 1],
    [11, 'varint', 76],
  ]);

test('Activity presets pair each start with its end into sessions, visits and spans', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'activity-presets-'),
  );
  const home = scratch.path;
  // An app switch writes the app left and the app entered at one instant;
  // Safari's end is missing, so Mail's start ends it; Codex is still in front.
  writeStream(home, 'App.InFocus', 'local', [
    [0, focus('com.apple.Notes', true, 0)],
    [10, focus('com.apple.Notes', false, 10)],
    [10, focus('com.apple.Safari', true, 10)],
    [25, focus('com.apple.mail', true, 25)],
    [30, focus('com.apple.mail', false, 30)],
    [40, focus('com.openai.codex', true, 40)],
  ]);
  writeStream(home, 'App.InFocus', 'PHONE-1', [
    [5, focus('net.whatsapp.WhatsApp', true, 5)],
    [7, focus('net.whatsapp.WhatsApp', false, 7)],
  ]);
  writeStream(home, 'ScreenTime.AppUsage', 'local', [
    ...(
      [
        [0, true],
        [10, false],
      ] as const
    ).map(
      ([minutes, started]) =>
        [
          minutes,
          protobuf([
            [1, 'varint', started ? 1 : 0],
            [2, 'double', unixSeconds(minutes)],
            [3, 'string', 'com.apple.Notes'],
            [5, 'varint', 1],
          ]),
        ] as const,
    ),
  ]);
  const media = (usageId: string, started: boolean, minutes: number) =>
    [
      minutes,
      protobuf([
        [1, 'varint', started ? 1 : 0],
        [2, 'string', 'com.apple.Music'],
        [5, 'varint', 1],
        [6, 'double', unixSeconds(minutes)],
        [8, 'string', usageId],
      ]),
    ] as const;
  writeStream(home, 'App.MediaUsage', 'local', [
    media('PLAY-1', true, 0),
    media('PLAY-1', false, 4),
    media('PLAY-2', true, 20),
  ]);
  const web = (usageId: string, state: number, minutes: number) =>
    [
      minutes,
      protobuf([
        [1, 'string', usageId],
        [2, 'double', appleSeconds(minutes)],
        [3, 'varint', state],
        [4, 'string', `https://example.com/${usageId}`],
        [5, 'string', 'example.com'],
        [6, 'string', 'com.apple.Safari'],
        [8, 'varint', 1],
      ]),
    ] as const;
  // Usage state 2 starts a visit and 1 ends it; a visit can first record 3.
  writeStream(home, 'App.WebUsage', 'local', [
    web('VISIT-1', 2, 0),
    web('VISIT-1', 1, 2),
    web('VISIT-2', 3, 5),
    web('VISIT-2', 2, 6),
    web('VISIT-2', 1, 9),
  ]);
  const mode = (modeId: string, semantic: string, started: boolean) =>
    protobuf([
      [1, 'string', modeId],
      [2, 'varint', started ? 1 : 0],
      [3, 'varint', 3],
      [4, 'varint', 6],
      [5, 'varint', 1],
      [6, 'string', semantic],
    ]);
  writeStream(home, 'UserFocus.ComputedMode', 'local', [
    [0, mode('MODE-W', 'com.apple.focus.work', true)],
    [60, mode('MODE-W', 'com.apple.focus.work', false)],
    [90, mode('MODE-S', 'com.apple.sleep.sleep-mode', true)],
  ]);
  // AA disconnects; BB connects twice with no disconnection between.
  writeStream(home, 'Device.Wireless.Bluetooth', 'local', [
    [0, bluetooth('AA:00:00:00:00:01', true)],
    [3, bluetooth('BB:00:00:00:00:02', true)],
    [8, bluetooth('AA:00:00:00:00:01', false)],
    [12, bluetooth('BB:00:00:00:00:02', true)],
  ]);
  mkdirSync(join(home, 'Library/Biome/sync'), { recursive: true });
  {
    using devices = new DatabaseSync(join(home, 'Library/Biome/sync/sync.db'));
    devices.exec(devicesSchema);
  }
  mkdirSync(join(home, 'Library/Application Support/Knowledge'), {
    recursive: true,
  });
  {
    using knowledge = new DatabaseSync(
      join(home, 'Library/Application Support/Knowledge/knowledgeC.db'),
    );
    knowledge.exec(knowledgeSchema);
  }

  const connector = await connectorUnder(home);
  const database = await importActivity(connector, join(home, 'import'));
  const presets = connector.presets();
  const rows = (view: string) =>
    read(database, presets, `SELECT * FROM ${view} ORDER BY 1, 2, 3, 4`);

  assert.deepEqual(
    presets.map(({ name }) => name),
    [
      'app_focus_sessions',
      'bluetooth_sessions',
      'focus_mode_spans',
      'media_sessions',
      'screen_time_sessions',
      'web_visits',
    ],
  );
  for (const preset of presets)
    assert.deepEqual(
      described(preset),
      [
        preset.name,
        ...read(
          database,
          presets,
          `SELECT name FROM pragma_table_info('${preset.name}')`,
        ).map(({ name }) => name),
      ],
      `${preset.file} describes its view and every column, in order`,
    );
  const span = (from: number, to: number | null) => ({
    started_at: iso(from),
    ended_at: to === null ? null : iso(to),
    seconds: to === null ? null : (to - from) * 60,
  });
  assert.deepEqual(rows('app_focus_sessions'), [
    { origin: 'PHONE-1', bundle_id: 'net.whatsapp.WhatsApp', ...span(5, 7) },
    { origin: 'local', bundle_id: 'com.apple.Notes', ...span(0, 10) },
    { origin: 'local', bundle_id: 'com.apple.Safari', ...span(10, 25) },
    { origin: 'local', bundle_id: 'com.apple.mail', ...span(25, 30) },
    { origin: 'local', bundle_id: 'com.openai.codex', ...span(40, null) },
  ]);
  assert.deepEqual(rows('screen_time_sessions'), [
    { origin: 'local', bundle_id: 'com.apple.Notes', ...span(0, 10) },
  ]);
  assert.deepEqual(rows('media_sessions'), [
    {
      origin: 'local',
      usage_id: 'PLAY-1',
      bundle_id: 'com.apple.Music',
      ...span(0, 4),
    },
    {
      origin: 'local',
      usage_id: 'PLAY-2',
      bundle_id: 'com.apple.Music',
      ...span(20, null),
    },
  ]);
  const visit = (usageId: string) => ({
    origin: 'local',
    usage_id: usageId,
    url: `https://example.com/${usageId}`,
    domain: 'example.com',
    bundle_id: 'com.apple.Safari',
    safari_profile_id: null,
  });
  assert.deepEqual(rows('web_visits'), [
    { ...visit('VISIT-1'), ...span(0, 2) },
    { ...visit('VISIT-2'), ...span(6, 9) },
  ]);
  assert.deepEqual(rows('focus_mode_spans'), [
    {
      origin: 'local',
      mode_id: 'MODE-S',
      semantic_mode_id: 'com.apple.sleep.sleep-mode',
      ...span(90, null),
    },
    {
      origin: 'local',
      mode_id: 'MODE-W',
      semantic_mode_id: 'com.apple.focus.work',
      ...span(0, 60),
    },
  ]);
  assert.deepEqual(rows('bluetooth_sessions'), [
    {
      origin: 'local',
      address: 'AA:00:00:00:00:01',
      device_name: 'Device AA',
      ...span(0, 8),
    },
    {
      origin: 'local',
      address: 'BB:00:00:00:00:02',
      device_name: 'Device BB',
      ...span(3, null),
    },
    {
      origin: 'local',
      address: 'BB:00:00:00:00:02',
      device_name: 'Device BB',
      ...span(12, null),
    },
  ]);
});
