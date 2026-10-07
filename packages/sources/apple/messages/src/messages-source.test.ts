import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtempDisposable, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import {
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  PipelineError,
  type ReadMessage,
  type Source,
  type Stream,
  StreamStatus,
  readerCatalog,
  syncHistoryRelations,
} from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
  SQLiteSyncHistory,
  installSQLiteCatalog,
} from '@workspace/elt-sqlite';
import { MacOSDocumentParser } from '@workspace/source-apple-macos/macos-document-parser';

import { AppleMessagesSource } from './apple-messages-source.ts';

// A file column's chunk table, by the documented rule: _elt_files_ and the
// first 40 hex digits of SHA-256 over the JSON of [table, column], both in
// ASCII lower case.
const chunkTable = (table: string, column: string) =>
  `"_elt_files_${createHash('sha256')
    .update(JSON.stringify([table.toLowerCase(), column.toLowerCase()]))
    .digest('hex')
    .slice(0, 40)}"`;

// Test support shared by the Apple source packages' tests.

const snake = (name: string) =>
  name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// One Apple source loaded as the hosts load it: every stream incrementally
// into raw_<stream> of one SQLite file, read through its documented
// <snake_stream> view, with files kept beside it.
async function appleImport(source: Source, directory: string) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const files = new LocalFiles({ directory: join(directory, 'files') });
  const { streams } = await source.discover();
  const connection = new Connection({
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
            .table(
              `raw_${stream.name}`,
              stream.supportsFileTransfer
                ? (columns) => [
                    ...SQLiteColumns.fromSchema(stream.jsonSchema),
                    columns
                      .text('attachmentRef')
                      .from(stream.file.store(files)),
                  ]
                : undefined,
            )
            .withReaderView(snake(stream.name)),
          {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          },
        ),
    ),
  });
  const history = new SQLiteSyncHistory();
  await history.install([destination]);
  installSQLiteCatalog({ path });
  const read = (sql: string) => {
    using database = new DatabaseSync(path, { readOnly: true });
    return database.prepare(sql).all();
  };
  return {
    load: () => new Pipeline({ history, connections: [connection] }).run(),
    read,
    // The documented views the streams publish, beside the catalog and the
    // sync history every SQLite load has.
    views: () =>
      read(`SELECT name FROM catalog WHERE kind = 'view' ORDER BY name`)
        .map(({ name }) => name)
        .filter(
          (name) =>
            name !== readerCatalog.name &&
            !Object.values(syncHistoryRelations).some(
              (relation) => relation.name === name,
            ),
        ),
  };
}

// Each stream's records from one full-refresh read of streams.
async function readRows(source: Source, streams: readonly Stream[]) {
  const rows = new Map<string, Record<string, unknown>[]>();
  for await (const message of source.read(
    streams.map((stream) => configured(stream)),
    new Map(),
  )) {
    if (message instanceof StreamStatus && message.status === 'FAILED')
      throw message.error;
    if ('data' in message)
      rows.set(message.stream, [
        ...(rows.get(message.stream) ?? []),
        Object(message.data),
      ]);
  }
  return (stream: Stream) => rows.get(stream.name) ?? [];
}

// The configured stream a full-refresh copy of stream reads.
const configured = (stream: Stream) =>
  new Copy(
    stream,
    new SQLiteDestination({ path: ':memory:' }).table(stream.name),
  ).configuration;

// One read of first then second, with a write committed between them; returns
// what second read and what a later read sees.
const acrossStreams = async (
  source: Source,
  [first, second]: [Stream, Stream],
  write: () => void,
  field: string,
) => {
  const values = (messages: readonly ReadMessage[]) =>
    messages
      .flatMap((message) =>
        'data' in message && message.stream === second.name
          ? [Reflect.get(Object(message.data), field)]
          : [],
      )
      .sort();
  const pinned: ReadMessage[] = [];
  for await (const message of source.read(
    [configured(first), configured(second)],
    new Map(),
  )) {
    pinned.push(message);
    if (
      message instanceof StreamStatus &&
      message.stream === first.name &&
      message.status === 'ENDED'
    )
      write();
  }
  const later = await Array.fromAsync(
    source.read([configured(second)], new Map()),
  );
  return { during: values(pinned), after: values(later) };
};

// One empty page: a valid PDF with no text layer.
const blankPdf = (() => {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
})();

// A PNG of the given line of text, drawn by AppKit, or a blank one.
const renderedText = (path: string, text: string | null) =>
  execFileSync('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `ObjC.import('AppKit');
    const image = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 640, 160, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(image);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext(context);
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, 640, 160));
    const text = ${JSON.stringify(text)};
    if (text !== null) {
      const attributes = $.NSMutableDictionary.alloc.init;
      attributes.setObjectForKey($.NSFont.systemFontOfSize(40), $.NSFontAttributeName);
      attributes.setObjectForKey($.NSColor.blackColor, $.NSForegroundColorAttributeName);
      $(text).drawAtPointWithAttributes($.NSMakePoint(20, 60), attributes);
    }
    context.flushGraphics;
    $.NSGraphicsContext.restoreGraphicsState;
    image.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(${JSON.stringify(path)}, true);`,
  ]);

// A chat.db with Messages' own table definitions, captured from macOS 27.0
// (schema only, no data), in WAL mode like the real file.
const chatSchema = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER DEFAULT 0, successful_query INTEGER, engram_id TEXT, server_change_token TEXT, ck_sync_state INTEGER DEFAULT 0, original_group_id TEXT, last_read_message_timestamp INTEGER DEFAULT 0, cloudkit_record_id TEXT, last_addressed_sim_id TEXT, is_blackholed INTEGER DEFAULT 0, syndication_date INTEGER DEFAULT 0, syndication_type INTEGER DEFAULT 0, is_recovered INTEGER DEFAULT 0, is_deleting_incoming_messages INTEGER DEFAULT 0, is_pending_review INTEGER DEFAULT 0);
  CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service) );
  CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT, replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0, is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_service_message INTEGER DEFAULT 0, is_forward INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0, is_archive INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, cache_roomnames TEXT, was_data_detected INTEGER DEFAULT 0, was_deduplicated INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, date_played INTEGER, item_type INTEGER DEFAULT 0, other_handle INTEGER DEFAULT 0, group_title TEXT, group_action_type INTEGER DEFAULT 0, share_status INTEGER DEFAULT 0, share_direction INTEGER DEFAULT 0, is_expirable INTEGER DEFAULT 0, expire_state INTEGER DEFAULT 0, message_action_type INTEGER DEFAULT 0, message_source INTEGER DEFAULT 0, associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, payload_data BLOB, expressive_send_style_id TEXT, associated_message_range_location INTEGER DEFAULT 0, associated_message_range_length INTEGER DEFAULT 0, time_expressive_send_played INTEGER, message_summary_info BLOB, ck_sync_state INTEGER DEFAULT 0, ck_record_id TEXT, ck_record_change_tag TEXT, destination_caller_id TEXT, is_corrupt INTEGER DEFAULT 0, reply_to_guid TEXT, sort_id INTEGER, is_spam INTEGER DEFAULT 0, has_unseen_mention INTEGER DEFAULT 0, thread_originator_guid TEXT, thread_originator_part TEXT, syndication_ranges TEXT, synced_syndication_ranges TEXT, was_delivered_quietly INTEGER DEFAULT 0, did_notify_recipient INTEGER DEFAULT 0, date_retracted INTEGER, date_edited INTEGER, was_detonated INTEGER DEFAULT 0, part_count INTEGER, is_stewie INTEGER DEFAULT 0, is_sos INTEGER DEFAULT 0, is_critical INTEGER DEFAULT 0, bia_reference_id TEXT, is_kt_verified INTEGER DEFAULT 0, fallback_hash TEXT, associated_message_emoji TEXT, is_pending_satellite_send INTEGER DEFAULT 0, needs_relay INTEGER DEFAULT 0, schedule_type INTEGER DEFAULT 0, schedule_state INTEGER DEFAULT 0, sent_or_received_off_grid INTEGER DEFAULT 0, date_recovered INTEGER DEFAULT 0, is_time_sensitive INTEGER DEFAULT 0, ck_chat_id TEXT, index_state INTEGER DEFAULT 0, filter_action INTEGER DEFAULT 0, filter_sub_action INTEGER DEFAULT 0, is_preview_sent INTEGER DEFAULT 0, is_preview_delivered INTEGER DEFAULT 0, date_preview_sent INTEGER, date_preview_delivered INTEGER, date_updated INTEGER, retry_count INTEGER);
  CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, start_date INTEGER DEFAULT 0, filename TEXT, uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, user_info BLOB, transfer_name TEXT, total_bytes INTEGER DEFAULT 0, is_sticker INTEGER DEFAULT 0, sticker_user_info BLOB, attribution_info BLOB, hide_attachment INTEGER DEFAULT 0, ck_sync_state INTEGER DEFAULT 0, ck_server_change_token_blob BLOB, ck_record_id TEXT, original_guid TEXT UNIQUE NOT NULL, is_commsafety_sensitive INTEGER DEFAULT 0, emoji_image_content_identifier TEXT, emoji_image_short_description TEXT, preview_generation_state INTEGER DEFAULT 0, preflight_info BLOB DEFAULT NULL, sensitivity_analysis INTEGER DEFAULT 0);
  CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, index_state INTEGER NOT NULL DEFAULT 0, filter_action INTEGER NOT NULL DEFAULT 0, filter_sub_action INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, message_id));
  CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
  CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
  CREATE TABLE chat_recoverable_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, delete_date INTEGER, ck_sync_state INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id), CHECK (delete_date != 0));
  CREATE TABLE recoverable_message_part (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, part_index INTEGER, delete_date INTEGER, part_text BLOB NOT NULL, ck_sync_state INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id, part_index), CHECK (delete_date != 0));
  CREATE TABLE chat_lookup (identifier TEXT NOT NULL, domain TEXT NOT NULL, chat INTEGER NOT NULL REFERENCES chat(ROWID) ON UPDATE CASCADE ON DELETE CASCADE, priority INTEGER DEFAULT 0, UNIQUE (identifier, domain));
  CREATE TABLE chat_service (service TEXT NOT NULL, chat INTEGER NOT NULL REFERENCES chat(ROWID) ON UPDATE CASCADE ON DELETE CASCADE, UNIQUE (service, chat));
`;

// A binary property list, encoded by plutil from XML.
const binaryPlist = (xml: string) =>
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
    input: `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${xml}</plist>`,
  });

// A link preview as Messages stores it in payload_data, archived by
// NSKeyedArchiver around a real LPLinkMetadata.
const linkPayload = () =>
  Buffer.from(
    execFileSync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import('LinkPresentation');
        const metadata = $.LPLinkMetadata.alloc.init;
        metadata.URL = $.NSURL.URLWithString('https://example.com/article');
        metadata.originalURL = $.NSURL.URLWithString('https://example.com/a');
        metadata.title = 'An article';
        metadata.siteName = 'Example';
        const root = $.NSMutableDictionary.alloc.init;
        root.setObjectForKey(metadata, 'richLinkMetadata');
        ObjC.unwrap($.NSKeyedArchiver.archivedDataWithRootObjectRequiringSecureCodingError(root, false, null).base64EncodedStringWithOptions(0));`,
      ],
      { encoding: 'utf8' },
    ),
    'base64',
  );

// An NSAttributedString in typedstream form, as Messages archives a body.
const archivedText = (text: string) => {
  const bytes = Buffer.from(text);
  const length =
    bytes.length < 0x80
      ? [bytes.length]
      : [0x81, bytes.length & 0xff, bytes.length >> 8];
  return Buffer.concat([
    Buffer.from(
      '\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+',
      'latin1',
    ),
    Buffer.from(length),
    bytes,
    Buffer.from('\x86\x84\x02iI\x01', 'latin1'),
  ]);
};

// Nanoseconds since 2001-01-01 UTC, Messages' modern time unit.
const appleNanoseconds = (iso: string) =>
  BigInt(Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1_000_000n;

const chatFixture = async (directory: string) => {
  const path = join(directory, 'chat.db');
  const attachment = join(directory, 'note.txt');
  await writeFile(attachment, 'attached words');
  using database = new DatabaseSync(path);
  database.exec(chatSchema);
  database.exec(`
    INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, group_id, style) VALUES (1, 'iMessage;-;+15550100', '+15550100', 'iMessage', '', 'group-1', 45);
    INSERT INTO handle VALUES (1, '+15550100', 'US', 'iMessage', '5550100', 'person-1');
    INSERT INTO chat_lookup VALUES ('+15550100', 'phone', 1, 0);
    INSERT INTO chat_service VALUES ('iMessage', 1);
    INSERT INTO chat_handle_join VALUES (1, 1);
    INSERT INTO attachment (ROWID, guid, original_guid, created_date, filename, mime_type, transfer_name, total_bytes)
      VALUES (1, 'att-local', 'att-local', 757000000, '${attachment}', 'text/plain', 'note.txt', 14),
             (2, 'att-offloaded', 'att-offloaded', 757000000, '${join(directory, 'gone.heic')}', 'image/heic', 'gone.heic', 900);
  `);
  const insert = database.prepare(
    'INSERT INTO message (ROWID, guid, text, attributedBody, handle_id, is_from_me, date, associated_message_guid, associated_message_type, cache_has_attachments, service) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
  );
  insert.run(
    1,
    'm-plain',
    'hello',
    null,
    0,
    appleNanoseconds('2025-01-02T03:04:05.006Z'),
    null,
    0,
    0,
    'iMessage',
  );
  insert.run(
    2,
    'm-archived',
    null,
    archivedText('é'.repeat(100)),
    1,
    appleNanoseconds('2025-01-02T03:05:00.000Z'),
    null,
    0,
    1,
    'iMessage',
  );
  insert.run(
    3,
    'm-reaction',
    null,
    null,
    1,
    appleNanoseconds('2025-01-02T03:06:00.000Z'),
    'p:0/m-plain',
    2000,
    0,
    'iMessage',
  );
  // Histories from before macOS 10.13 stored whole seconds.
  insert.run(4, 'm-old', 'from 2016', null, 0, 500000000, null, 0, 0, 'SMS');
  insert.run(
    5,
    'm-deleted',
    'regretted',
    null,
    1,
    appleNanoseconds('2025-01-02T03:07:00.000Z'),
    null,
    0,
    0,
    'iMessage',
  );
  // Edit history as Messages keeps it: part 0's versions, each a time in
  // seconds since 2001 and an archived body. date_edited can stay 0.
  database
    .prepare(
      "UPDATE message SET message_summary_info = ? WHERE guid = 'm-plain'",
    )
    .run(
      binaryPlist(
        `<dict><key>ec</key><dict><key>0</key><array><dict><key>d</key><real>757393445.006</real><key>t</key><data>${archivedText('helo').toString('base64')}</data></dict><dict><key>d</key><real>757393460.5</real><key>t</key><data>${archivedText('hello').toString('base64')}</data></dict></array></dict><key>ust</key><true/></dict>`,
      ),
    );
  database
    .prepare(
      "INSERT INTO message (ROWID, guid, text, handle_id, date, balloon_bundle_id, payload_data) VALUES (6, 'm-link', 'https://example.com/a', 1, ?, 'com.apple.messages.URLBalloonProvider', ?)",
    )
    .run(appleNanoseconds('2025-01-02T03:08:00.000Z'), linkPayload());
  database.exec(`
    INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, 1), (1, 2), (1, 3), (1, 4), (1, 6);
    INSERT INTO message_attachment_join VALUES (2, 1), (2, 2);
  `);
  // Recently Deleted: the row stays in message, its chat link moves here.
  database
    .prepare(
      'INSERT INTO chat_recoverable_message_join (chat_id, message_id, delete_date) VALUES (1, 5, ?)',
    )
    .run(appleNanoseconds('2025-01-02T04:00:00.000Z'));
  database
    .prepare(
      'INSERT INTO recoverable_message_part (chat_id, message_id, part_index, delete_date, part_text) VALUES (1, 5, 0, ?, ?)',
    )
    .run(
      appleNanoseconds('2025-01-02T04:00:00.000Z'),
      archivedText('regretted'),
    );
  return path;
};

const messagesRows = (path: string, sql: string) => {
  using database = new DatabaseSync(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
};

test('the document parser reads every attachment kind and throws only on unreadable files', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-parse-'));
  const path = await chatFixture(scratch.path);
  const files = join(scratch.path, 'Attachments');
  mkdirSync(files);
  const file = async (name: string, content: string | Uint8Array) => {
    const at = join(files, name);
    await writeFile(at, content);
    return at;
  };
  const photo = join(files, 'receipt.png');
  renderedText(photo, 'Invoice 4821 due Friday');
  const heic = join(files, 'receipt.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', photo, '--out', heic]);
  const blank = join(files, 'blank.png');
  renderedText(blank, null);
  const card =
    'BEGIN:VCARD\nVERSION:3.0\nFN:Ada Lovelace\nTEL:+15550100\nEND:VCARD\n';
  using chat = new DatabaseSync(path);
  // Each file as Messages records an attachment: a row naming its path.
  const attach = (guid: string, filename: string) =>
    chat
      .prepare(
        'INSERT INTO attachment (guid, original_guid, filename) VALUES (?, ?, ?)',
      )
      .run(guid, guid, filename);
  for (const [guid, filename] of [
    ['photo', photo],
    ['heic', heic],
    ['noExtension', await file('GroupPhotoImage', await readFile(heic))],
    ['blankImage', blank],
    ['blankPdf', await file('blank.pdf', blankPdf)],
    ['text', await file('hello.txt', 'hello')],
    ['card', await file('Ada.vcf', card)],
    ['location', await file('CL.loc.vcf', card)],
    ['video', await file('clip.mov', Uint8Array.of(0, 1, 2))],
    [
      'unknown',
      await file('pluginPayloadAttachment', Uint8Array.of(9, 9, 9, 9)),
    ],
  ] as const)
    attach(guid, filename);
  const source = new AppleMessagesSource(path);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            source.attachments,
            destination.table('attachments', (c) => [
              c.text('guid'),
              c
                .text('content')
                .from(source.attachments.file)
                .parse(new MacOSDocumentParser()),
            ]),
          ),
        ],
      }),
    ],
  });

  await pipeline.run();

  assert.deepEqual(
    Object.fromEntries(
      messagesRows(
        destination.path,
        'SELECT guid, content FROM attachments',
      ).map(({ guid, content }) => [guid, content]),
    ),
    {
      'att-local': 'attached words',
      'att-offloaded': null,
      photo: 'Invoice 4821 due Friday',
      heic: 'Invoice 4821 due Friday',
      noExtension: 'Invoice 4821 due Friday',
      blankImage: null,
      blankPdf: null,
      text: 'hello',
      card,
      location: card,
      video: null,
      unknown: null,
    },
  );
  for (const [name, content, message] of [
    ['corrupt.pdf', 'not a pdf', /Cannot read PDF/],
    ['corrupt.heic', Uint8Array.of(0, 1, 2), /Cannot read image/],
  ] as const) {
    attach(name, await file(name, content));
    await assert.rejects(
      pipeline.run(),
      (error: unknown) =>
        error instanceof PipelineError &&
        error.cause instanceof Error &&
        message.test(error.cause.message),
    );
    chat.prepare('DELETE FROM attachment WHERE guid = ?').run(name);
  }
});

test('Messages scope filters chat and native dates before decoding attachments and saving checkpoints', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'messages-scope-'),
  );
  const path = await chatFixture(scratch.path);
  using native = new DatabaseSync(path);
  // Invalid archived content on an excluded message must never be decoded.
  native.exec(
    "UPDATE message SET attributedBody=X'010203' WHERE guid='m-archived'",
  );
  const source = new AppleMessagesSource(path, {
    collectionIds: ['iMessage;-;+15550100'],
    startAt: '2025-01-02T03:04:05.006Z',
    endAt: '2025-01-02T03:04:05.007Z',
  });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  await new Pipeline({
    connections: [
      new Connection({
        name: 'scope',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: stream.name,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  }).run();
  assert.deepEqual(
    messagesRows(destination.path, 'SELECT guid FROM messages'),
    [{ guid: 'm-plain' }],
  );
  assert.deepEqual(
    messagesRows(destination.path, 'SELECT guid FROM attachments'),
    [],
  );
  const saved = JSON.stringify(
    messagesRows(
      join(scratch.path, 'state.sqlite'),
      'SELECT state FROM checkpoints',
    ),
  );
  assert.ok(saved.includes('m-plain'));
  assert.ok(!saved.includes('m-archived') && !saved.includes('att-local'));
});

test('Messages exports every stream by guid, decodes archived text and streams local attachments', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const source = new AppleMessagesSource(await chatFixture(scratch.path));
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const plain = (await source.discover()).streams
    .filter((stream) => stream !== source.attachments)
    .map((stream) => new Copy(stream, destination.table(stream.name)));
  const attachments = new Copy(
    source.attachments,
    destination.table('attachments', (c) => [
      ...SQLiteColumns.fromSchema(source.attachments.jsonSchema),
      c
        .text('content')
        .from(source.attachments.file)
        .parse(new MacOSDocumentParser()),
      c.blob('bytes').from(source.attachments.file),
    ]),
  );

  const results = await new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [...plain, attachments],
      }),
    ],
  }).run();

  assert.deepEqual(
    results.map(({ copy, count }) => [copy.from.name, count]),
    [
      ['chats', 1],
      ['handles', 1],
      ['chatLookups', 1],
      ['chatServices', 1],
      ['chatHandles', 1],
      ['messages', 6],
      ['chatMessages', 5],
      ['linkPreviews', 1],
      ['messageEdits', 2],
      ['recoverableMessages', 1],
      ['recoverableMessageParts', 1],
      ['messageAttachments', 2],
      ['attachments', 2],
    ],
  );
  const out = destination.path;
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT guid, text, handle, isFromMe, date, associatedMessageGuid, associatedMessageType, cacheHasAttachments, attributedBody IS NOT NULL AS archived FROM messages ORDER BY date',
    ),
    [
      {
        guid: 'm-old',
        text: 'from 2016',
        handle: '+15550100',
        isFromMe: 0,
        date: '2016-11-05T00:53:20.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-plain',
        text: 'hello',
        handle: '+15550100',
        isFromMe: 0,
        date: '2025-01-02T03:04:05.006Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        handle: '+15550100',
        isFromMe: 1,
        date: '2025-01-02T03:05:00.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 1,
        archived: 1,
      },
      {
        guid: 'm-reaction',
        text: null,
        handle: '+15550100',
        isFromMe: 1,
        date: '2025-01-02T03:06:00.000Z',
        associatedMessageGuid: 'p:0/m-plain',
        associatedMessageType: 2000,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-deleted',
        text: 'regretted',
        handle: '+15550100',
        isFromMe: 1,
        date: '2025-01-02T03:07:00.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
      {
        guid: 'm-link',
        text: 'https://example.com/a',
        handle: '+15550100',
        isFromMe: 0,
        date: '2025-01-02T03:08:00.000Z',
        associatedMessageGuid: null,
        associatedMessageType: 0,
        cacheHasAttachments: 0,
        archived: 0,
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT messageGuid, url, originalUrl, title, summary, siteName, json_extract(metadata, \'$."$class"\') AS class FROM linkPreviews',
    ),
    [
      {
        messageGuid: 'm-link',
        url: 'https://example.com/article',
        originalUrl: 'https://example.com/a',
        title: 'An article',
        summary: null,
        siteName: 'Example',
        class: 'LPLinkMetadata',
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT messageGuid, partIndex, version, editedAt, text FROM messageEdits ORDER BY version',
    ),
    [
      {
        messageGuid: 'm-plain',
        partIndex: 0,
        version: 0,
        editedAt: '2025-01-01T03:04:05.006Z',
        text: 'helo',
      },
      {
        messageGuid: 'm-plain',
        partIndex: 0,
        version: 1,
        editedAt: '2025-01-01T03:04:20.500Z',
        text: 'hello',
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      "SELECT json_extract(messageSummaryInfo, '$.ust') AS ust, json_type(messageSummaryInfo, '$.ec.0[0].t') AS body FROM messages WHERE guid = 'm-plain'",
    ),
    [{ ust: 1, body: 'text' }],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT r.chatGuid, r.messageGuid, r.deleteDate, p.partIndex, p.partText IS NOT NULL AS archivedPart FROM recoverableMessages r JOIN recoverableMessageParts p USING (messageGuid)',
    ),
    [
      {
        chatGuid: 'iMessage;-;+15550100',
        messageGuid: 'm-deleted',
        deleteDate: '2025-01-02T04:00:00.000Z',
        partIndex: 0,
        archivedPart: 1,
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      `SELECT a.guid, a.availableLocally, a.content, (SELECT c.bytes FROM ${chunkTable('attachments', 'bytes')} c WHERE c.file = a.bytes) AS bytes FROM attachments a ORDER BY a.guid`,
    ),
    [
      {
        guid: 'att-local',
        availableLocally: 1,
        content: 'attached words',
        bytes: new Uint8Array(Buffer.from('attached words')),
      },
      {
        guid: 'att-offloaded',
        availableLocally: 0,
        content: null,
        bytes: null,
      },
    ],
  );
  assert.deepEqual(
    messagesRows(
      out,
      'SELECT messageGuid, attachmentGuid FROM messageAttachments ORDER BY attachmentGuid',
    ),
    [
      { messageGuid: 'm-archived', attachmentGuid: 'att-local' },
      { messageGuid: 'm-archived', attachmentGuid: 'att-offloaded' },
    ],
  );
});

test('Messages loads edits and unsends incrementally and deletes removed messages', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const copy = new Copy(source.messages, destination.table('messages'), {
    id: 'messages',
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [copy],
      }),
    ],
  });

  await pipeline.run();
  const unchanged = await pipeline.run();
  {
    using chat = new DatabaseSync(path);
    chat
      .prepare(
        "UPDATE message SET text = 'hello again', date_edited = ? WHERE guid = 'm-plain'",
      )
      .run(appleNanoseconds('2025-01-03T00:00:00.000Z'));
    chat
      .prepare(
        "UPDATE message SET date_retracted = ? WHERE guid = 'm-archived'",
      )
      .run(appleNanoseconds('2025-01-03T00:01:00.000Z'));
    chat.exec("DELETE FROM message WHERE guid = 'm-old'");
  }
  const changed = await pipeline.run();

  assert.deepEqual(
    [unchanged, changed].map((results) =>
      results.map(({ count, deleted }) => ({ count, deleted })),
    ),
    [[{ count: 0, deleted: 0 }], [{ count: 2, deleted: 1 }]],
  );
  assert.deepEqual(
    messagesRows(
      destination.path,
      'SELECT guid, text, dateEdited, dateRetracted FROM messages ORDER BY guid',
    ),
    [
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        dateEdited: null,
        dateRetracted: '2025-01-03T00:01:00.000Z',
      },
      {
        guid: 'm-deleted',
        text: 'regretted',
        dateEdited: null,
        dateRetracted: null,
      },
      {
        guid: 'm-link',
        text: 'https://example.com/a',
        dateEdited: null,
        dateRetracted: null,
      },
      {
        guid: 'm-plain',
        text: 'hello again',
        dateEdited: '2025-01-03T00:00:00.000Z',
        dateRetracted: null,
      },
      { guid: 'm-reaction', text: null, dateEdited: null, dateRetracted: null },
    ],
  );
});

test('one Messages read sees one moment of chat.db while Messages keeps writing', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
  const { during, after } = await acrossStreams(
    source,
    [source.handles, source.messages],
    () => {
      using chat = new DatabaseSync(path);
      chat.exec("INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')");
    },
    'guid',
  );

  assert.ok(!during.includes('m-new'));
  assert.deepEqual(after, [...during, 'm-new'].sort());
});

test('Messages names Full Disk Access when chat.db cannot be opened', async () => {
  const source = new AppleMessagesSource(join(tmpdir(), 'missing', 'chat.db'));

  const opening = Array.fromAsync(
    source.read([configured(source.messages)], new Map()),
  );

  await assert.rejects(opening, (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'MessagesUnavailableError');
    assert.match(error.message, /Full Disk Access/);
    assert.ok(error.cause instanceof Error);
    return true;
  });
});

test('property lists decode as Foundation wrote them', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-plist-'));
  const path = await chatFixture(scratch.path);
  const plain = binaryPlist(
    '<dict><key>ascii</key><string>hello</string><key>unicode</key><string>é 😀</string><key>big</key><integer>9007199254740993</integer><key>negative</key><integer>-5</integer><key>real</key><real>1.5</real><key>yes</key><true/><key>when</key><date>2025-01-02T03:04:05Z</date><key>bytes</key><data>AQID</data><key>list</key><array><integer>1</integer><string>two</string></array></dict>',
  );
  // A link preview whose archive also holds Foundation values Messages may
  // keep beside it, archived by NSKeyedArchiver.
  const keyed = Buffer.from(
    execFileSync(
      '/usr/bin/osascript',
      [
        '-l',
        'JavaScript',
        '-e',
        `ObjC.import('LinkPresentation');
        const metadata = $.LPLinkMetadata.alloc.init;
        metadata.URL = $.NSURL.URLWithStringRelativeToURL('page', $.NSURL.URLWithString('https://example.com/dir/'));
        metadata.title = 'An article';
        const root = $.NSMutableDictionary.alloc.init;
        root.setObjectForKey(metadata, 'richLinkMetadata');
        root.setObjectForKey($.NSDate.dateWithTimeIntervalSince1970(1735787045), 'when');
        root.setObjectForKey($.NSUUID.alloc.initWithUUIDString('12345678-9ABC-DEF0-1234-56789ABCDEF0'), 'id');
        root.setObjectForKey($.NSArray.arrayWithArray($(['a', 'b'])), 'items');
        root.setObjectForKey($('abc').dataUsingEncoding($.NSUTF8StringEncoding), 'bytes');
        root.setObjectForKey($.NSURL.URLWithStringRelativeToURL('page', $.NSURL.URLWithString('https://example.com/dir/')), 'url');
        ObjC.unwrap($.NSKeyedArchiver.archivedDataWithRootObjectRequiringSecureCodingError(root, false, null).base64EncodedStringWithOptions(0));`,
      ],
      { encoding: 'utf8' },
    ),
    'base64',
  );
  {
    using chat = new DatabaseSync(path);
    chat
      .prepare(
        "UPDATE message SET message_summary_info = ? WHERE guid = 'm-old'",
      )
      .run(plain);
    chat
      .prepare("UPDATE message SET payload_data = ? WHERE guid = 'm-link'")
      .run(keyed);
  }
  const source = new AppleMessagesSource(path);

  const rows = await readRows(source, [source.messages, source.linkPreviews]);

  const message = (guid: string) =>
    rows(source.messages).find((row) => row.guid === guid);
  assert.deepEqual(JSON.parse(String(message('m-old')?.messageSummaryInfo)), {
    ascii: 'hello',
    unicode: 'é 😀',
    big: '9007199254740993',
    negative: -5,
    real: 1.5,
    yes: true,
    when: '2025-01-02T03:04:05.000Z',
    bytes: 'AQID',
    list: [1, 'two'],
  });
  const { richLinkMetadata, ...archived } = JSON.parse(
    String(message('m-link')?.payloadData),
  );
  assert.deepEqual(archived, {
    when: '2025-01-02T03:04:05.000Z',
    id: '12345678-9ABC-DEF0-1234-56789ABCDEF0',
    items: ['a', 'b'],
    bytes: 'YWJj',
    url: 'https://example.com/dir/page',
  });
  assert.equal(richLinkMetadata.$class, 'LPLinkMetadata');
  assert.deepEqual(
    rows(source.linkPreviews).map(({ messageGuid, url, title, metadata }) => ({
      messageGuid,
      url,
      title,
      class: JSON.parse(String(metadata)).$class,
    })),
    [
      {
        messageGuid: 'm-link',
        url: 'https://example.com/dir/page',
        title: 'An article',
        class: 'LPLinkMetadata',
      },
    ],
  );
});

test('a Messages watch loads each commit Messages makes while it keeps chat.db open', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'elt-messages-'),
  );
  const path = await chatFixture(scratch.path);
  const source = new AppleMessagesSource(path);
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.messages, destination.table('messages'), {
            id: 'messages',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  // Messages holds its connection, and so its WAL, open the whole time.
  using messages = new DatabaseSync(path);
  const controller = new AbortController();
  const batches: number[] = [];

  for await (const { outcomes } of pipeline.watch({
    // A batch that never comes ends the watch, so the assertion fails.
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
  })) {
    batches.push(outcomes[0]?.count ?? -1);
    if (batches.length === 1)
      messages.exec(
        "INSERT INTO message (guid, text) VALUES ('m-new', 'arrived')",
      );
    // Past the next one-second poll, so a spurious batch would show.
    else setTimeout(() => controller.abort(), 1500);
  }

  assert.deepEqual(batches, [6, 1]);
});

test('Messages reads as documented views joined on both handle keys and counted at message grain', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'messages-marts-'),
  );
  const path = await chatFixture(scratch.path);
  {
    // The same address on SMS is another handle; one message is in two chats.
    using database = new DatabaseSync(path);
    database.exec(`
      INSERT INTO handle VALUES (2, '+15550100', 'US', 'SMS', '5550100', 'person-1');
      UPDATE message SET handle_id = 2 WHERE guid = 'm-old';
      INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, group_id, style) VALUES (2, 'SMS;-;+15550100', '+15550100', 'SMS', '', 'group-2', 45);
      INSERT INTO chat_message_join (chat_id, message_id) VALUES (2, 1);
    `);
  }
  const messages = await appleImport(
    new AppleMessagesSource(path),
    join(scratch.path, 'import'),
  );
  await messages.load();

  // One documented view per stream, named after the stream.
  assert.deepEqual(messages.views(), [
    'attachments',
    'chat_handles',
    'chat_lookups',
    'chat_messages',
    'chat_services',
    'chats',
    'handles',
    'link_previews',
    'message_attachments',
    'message_edits',
    'messages',
    'recoverable_message_parts',
    'recoverable_messages',
  ]);
  assert.deepEqual(
    messages
      .read(
        `
        SELECT h.service, count(m.guid) AS messages
        FROM handles h
        LEFT JOIN messages m ON m.handle = h.id AND m."handleService" = h.service
        GROUP BY h.service ORDER BY h.service`,
      )
      .map((found) => ({ ...found })),
    [
      { service: 'SMS', messages: 1 },
      { service: 'iMessage', messages: 5 },
    ],
  );
  assert.deepEqual(
    messages
      .read(
        `
        SELECT count(*) AS joined, count(DISTINCT m.guid) AS messages
        FROM messages m JOIN chat_messages c ON c."messageGuid" = m.guid`,
      )
      .map((found) => ({ ...found })),
    [{ joined: 6, messages: 5 }],
  );
  assert.deepEqual(
    messages
      .read(
        `
        SELECT m.guid, m.text, (SELECT count(*) FROM message_edits e WHERE e."messageGuid" = m.guid) AS edits,
          EXISTS (SELECT 1 FROM recoverable_messages r WHERE r."messageGuid" = m.guid) AS recoverable
        FROM messages m WHERE m.guid IN ('m-plain', 'm-archived', 'm-deleted') ORDER BY m.guid`,
      )
      .map((found) => ({ ...found })),
    [
      {
        guid: 'm-archived',
        text: 'é'.repeat(100),
        edits: 0,
        recoverable: 0,
      },
      { guid: 'm-deleted', text: 'regretted', edits: 0, recoverable: 1 },
      { guid: 'm-plain', text: 'hello', edits: 2, recoverable: 0 },
    ],
  );
  const files = Object.fromEntries(
    messages
      .read(`SELECT guid, "attachmentRef" FROM attachments`)
      .map(({ guid, attachmentRef }) => [guid, attachmentRef]),
  );
  assert.equal(await readFile(files['att-local'], 'utf8'), 'attached words');
  assert.equal(files['att-offloaded'], null);
});
