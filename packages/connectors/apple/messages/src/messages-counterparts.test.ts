import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import { Settings } from '@workspace/settings';

// This package's folder, which holds its manifest.
const folder = fileURLToPath(new URL('..', import.meta.url));

// The SDK finds chat.db under HOME when its module loads, so the connector is
// imported only after HOME points at the test's folder. node --test runs this
// file in its own process.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: MessagesConnector } =
      await import('./messages-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Messages reads nothing through EventKit.
    return new MessagesConnector(
      { grantee: 'Codex', eventKitHelper: '' },
      { name: contextCompiler.name, title: contextCompiler.title, folder },
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

// One pass as the hosts run it, from a saved selection into its import.
async function importAll(
  connector: AppleConnector,
  root: string,
): Promise<string> {
  using settings = new Settings(root);
  const selection = {
    connector: connector.name,
    scope: {},
    includeAttachments: false,
  };
  settings.select([selection], {
    facts: () => connector,
    permissions: () => connector.guidance(),
  });
  const outcome = await connector.import(settings, selection);
  assert.deepEqual(outcome, { status: 'imported' });
  return settings.database(selection);
}

// Reads as query-apple tells the agent to: the macOS sqlite3 shell,
// read-only. A failing statement fails the test rather than reading as no rows.
function read(database: string, sql: string): Record<string, unknown>[] {
  const result = spawnSync(
    '/usr/bin/sqlite3',
    ['-readonly', '-json', '-cmd', '.timeout 30000', database, sql],
    { encoding: 'utf8' },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  return JSON.parse(result.stdout || '[]');
}

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

// Nanoseconds since 2001-01-01 UTC, Messages' modern time unit.
const at = (iso: string) =>
  BigInt(Date.parse(iso) - Date.UTC(2001, 0, 1)) * 1_000_000n;

// chat.db where HOME's Messages keeps it, holding rows.
function chatDatabaseUnder(home: string, rows: string): void {
  const directory = join(home, 'Library/Messages');
  mkdirSync(directory, { recursive: true });
  using database = new DatabaseSync(join(directory, 'chat.db'));
  database.exec(chatSchema);
  database.exec(rows);
}

// One counterparts row with the columns Messages always leaves NULL.
const row = (
  relation: string,
  identifier_type: string,
  identifier: string,
  name: string | null,
  first_at: string,
  last_at: string,
  occurrences: number,
  context: string,
) => ({
  relation,
  identifier_type,
  identifier,
  linked_type: null,
  linked_identifier: null,
  name,
  first_at,
  last_at,
  occurrences,
  context,
});

test("Messages counterparts name each handle once across services, give the user's own messages to the handles of their chat, and mark the user's own phone and address", async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'messages-counterparts-'),
  );
  chatDatabaseUnder(
    home.path,
    `
    INSERT INTO handle (ROWID, id, country, service) VALUES
      (1, '962791111111', 'JO', 'SMS'),
      (2, '+962791111111', 'JO', 'iMessage'),
      (3, 'Rana@Example.com', 'JO', 'iMessage'),
      (4, '98877', 'JO', 'SMS'),
      (5, 'ArabBank', 'JO', 'SMS'),
      (6, '+962792222222', 'JO', 'iMessage'),
      (7, '0791234567', 'JO', 'SMS');
    INSERT INTO chat (ROWID, guid, chat_identifier, service_name, display_name, style, account_login) VALUES
      (1, 'any;-;+962791111111', '+962791111111', 'iMessage', '', 45, 'P:+962790000001'),
      (2, 'iMessage;-;rana@example.com', 'rana@example.com', 'iMessage', 'Rana', 45, 'E:Ezz@Example.com'),
      (3, 'SMS;-;98877', '98877', 'SMS', '', 45, NULL),
      (4, 'SMS;-;ArabBank', 'ArabBank', 'SMS', '', 45, NULL),
      (5, 'iMessage;+;chat1', 'chat1', 'iMessage', 'Builders', 43, NULL),
      (6, 'SMS;-;0791234567', '0791234567', 'SMS', '', 45, NULL);
    INSERT INTO chat_handle_join VALUES (1, 2), (2, 3), (3, 4), (4, 5), (5, 3), (5, 6), (6, 7);
    INSERT INTO message (ROWID, guid, handle_id, is_from_me, date, service, account, destination_caller_id) VALUES
      (1, 'm1', 1, 0, ${at('2025-01-01T10:00:00Z')}, 'SMS', NULL, '+962790000001'),
      (2, 'm2', 2, 0, ${at('2025-01-02T10:00:00Z')}, 'iMessage', 'P:+962790000001', '+962790000001'),
      (3, 'm3', 0, 1, ${at('2025-01-03T10:00:00Z')}, 'iMessage', 'P:+962790000001', '+962790000001'),
      (4, 'm4', 3, 0, ${at('2025-02-01T10:00:00Z')}, 'iMessage', 'E:ezz@example.com', 'Ezz@Example.com'),
      (5, 'm5', 0, 1, ${at('2025-02-02T10:00:00Z')}, 'iMessage', 'E:ezz@example.com', 'ezz@example.com'),
      (6, 'm6', 0, 1, ${at('2025-02-03T10:00:00Z')}, 'iMessage', NULL, NULL),
      (7, 'm7', 4, 0, ${at('2025-03-01T10:00:00Z')}, 'SMS', NULL, '405DF2E3-5F25-48D8-861D-9BE5E30F73FC'),
      (8, 'm8', 0, 1, ${at('2025-03-02T10:00:00Z')}, 'SMS', NULL, '405DF2E3-5F25-48D8-861D-9BE5E30F73FC'),
      (9, 'm9', 5, 0, ${at('2025-04-01T10:00:00Z')}, 'SMS', 'P:+962790000001', NULL),
      (10, 'm10', 5, 0, ${at('2025-04-05T10:00:00Z')}, 'SMS', 'E:', NULL),
      (11, 'm11', 0, 1, ${at('2025-05-01T10:00:00Z')}, 'iMessage', 'E:ezz@example.com', NULL),
      (12, 'm12', 6, 0, ${at('2025-05-02T10:00:00Z')}, 'iMessage', NULL, NULL),
      (13, 'm13', 3, 0, ${at('2025-05-03T10:00:00Z')}, 'iMessage', NULL, NULL),
      (14, 'm14', 7, 0, ${at('2025-06-01T10:00:00Z')}, 'SMS', NULL, NULL),
      (15, 'm15', 6, 0, ${at('2024-12-01T10:00:00Z')}, 'iMessage', NULL, NULL),
      (16, 'm16', 0, 1, ${at('2024-12-01T10:05:00Z')}, 'iMessage', NULL, NULL);
    INSERT INTO chat_message_join (chat_id, message_id) VALUES
      (1, 1), (1, 2), (1, 3), (2, 4), (2, 5), (3, 7), (3, 8), (4, 9), (4, 10), (5, 11), (5, 12), (5, 13), (6, 14);
    INSERT INTO chat_recoverable_message_join (chat_id, message_id, delete_date) VALUES (2, 6, ${at('2025-02-04T10:00:00Z')});
    `,
  );
  const connector = await connectorUnder(home.path);

  const database = await importAll(connector, join(home.path, 'Apple'));

  assert.deepEqual(
    read(
      database,
      'SELECT relation, identifier_type, identifier, linked_type, linked_identifier, name, first_at, last_at, occurrences, context FROM counterparts ORDER BY relation, identifier',
    ),
    [
      // A group chat's handles are members, timed by its messages.
      row(
        'member',
        'phone',
        '+962792222222',
        null,
        '2025-05-01T10:00:00.000Z',
        '2025-05-03T10:00:00.000Z',
        1,
        '{"services":["iMessage"],"largest":2}',
      ),
      row(
        'member',
        'email',
        'rana@example.com',
        'Rana',
        '2025-05-01T10:00:00.000Z',
        '2025-05-03T10:00:00.000Z',
        1,
        '{"services":["iMessage"],"largest":2}',
      ),
      // The number written as 962… under SMS and as +962… under iMessage is
      // one handle.
      row(
        'received',
        'phone',
        '+962791111111',
        null,
        '2025-01-01T10:00:00.000Z',
        '2025-01-02T10:00:00.000Z',
        2,
        '{"services":["SMS","iMessage"],"direct":2,"group":0}',
      ),
      // A message whose chat is gone still has its sender.
      row(
        'received',
        'phone',
        '+962792222222',
        null,
        '2024-12-01T10:00:00.000Z',
        '2025-05-02T10:00:00.000Z',
        2,
        '{"services":["iMessage"],"direct":0,"group":1}',
      ),
      // A national number has no E.164 form without its country.
      row(
        'received',
        'app',
        '0791234567',
        null,
        '2025-06-01T10:00:00.000Z',
        '2025-06-01T10:00:00.000Z',
        1,
        '{"services":["SMS"],"direct":1,"group":0}',
      ),
      // A short code is its digits.
      row(
        'received',
        'app',
        '98877',
        null,
        '2025-03-01T10:00:00.000Z',
        '2025-03-01T10:00:00.000Z',
        1,
        '{"services":["SMS"],"direct":1,"group":0}',
      ),
      // A sender name is the name Messages shows.
      row(
        'received',
        'app',
        'ArabBank',
        'ArabBank',
        '2025-04-01T10:00:00.000Z',
        '2025-04-05T10:00:00.000Z',
        2,
        '{"services":["SMS"],"direct":2,"group":0}',
      ),
      row(
        'received',
        'email',
        'rana@example.com',
        'Rana',
        '2025-02-01T10:00:00.000Z',
        '2025-05-03T10:00:00.000Z',
        2,
        '{"services":["iMessage"],"direct":1,"group":1}',
      ),
      // The SIM ID in destinationCallerId names no one; the user's own
      // spellings of one address are one identifier.
      row(
        'self',
        'phone',
        '+962790000001',
        null,
        '2025-01-01T10:00:00.000Z',
        '2025-04-01T10:00:00.000Z',
        5,
        '{"services":["SMS","iMessage"]}',
      ),
      row(
        'self',
        'email',
        'ezz@example.com',
        null,
        '2025-02-01T10:00:00.000Z',
        '2025-05-01T10:00:00.000Z',
        4,
        '{"services":["iMessage"]}',
      ),
      // The user's messages carry no handle: each goes to the handles of its
      // chat, a deleted one still recoverable included, and the user's message
      // whose chat is gone names no one.
      row(
        'sent',
        'phone',
        '+962791111111',
        null,
        '2025-01-03T10:00:00.000Z',
        '2025-01-03T10:00:00.000Z',
        1,
        '{"services":["iMessage"],"direct":1,"group":0}',
      ),
      row(
        'sent',
        'phone',
        '+962792222222',
        null,
        '2025-05-01T10:00:00.000Z',
        '2025-05-01T10:00:00.000Z',
        1,
        '{"services":["iMessage"],"direct":0,"group":1}',
      ),
      row(
        'sent',
        'app',
        '98877',
        null,
        '2025-03-02T10:00:00.000Z',
        '2025-03-02T10:00:00.000Z',
        1,
        '{"services":["SMS"],"direct":1,"group":0}',
      ),
      row(
        'sent',
        'email',
        'rana@example.com',
        'Rana',
        '2025-02-02T10:00:00.000Z',
        '2025-05-01T10:00:00.000Z',
        3,
        '{"services":["iMessage"],"direct":2,"group":1}',
      ),
    ],
  );
  // Readers find the view and every column described in the catalog.
  assert.equal(
    read(
      database,
      "SELECT count(*) AS n FROM catalog WHERE name LIKE 'counterparts.%' AND description <> ''",
    )[0]?.n,
    10,
  );
});
