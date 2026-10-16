import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Mail reads its store and the Accounts store under HOME when its modules
// load, so the connector is imported only after HOME points at the test's
// folder. node --test runs this file in its own process.
async function connectorUnder(home: string): Promise<AppleConnector> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    const { default: MailConnector } = await import('./mail-connector.ts');
    const { contextCompiler } = JSON.parse(
      readFileSync(join(folder, 'package.json'), 'utf8'),
    );
    // Mail reads nothing through EventKit.
    return new MailConnector(
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

// Envelope Index's tables as Mail creates them (schema only), in WAL mode
// like the real store.
const envelopeIndexSchema = `PRAGMA journal_mode = WAL;
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER NOT NULL DEFAULT 0,
global_message_id INTEGER NOT NULL,
remote_id INTEGER,
document_id TEXT COLLATE BINARY,
sender INTEGER,
subject_prefix TEXT COLLATE BINARY,
subject INTEGER NOT NULL,
summary INTEGER,
date_sent INTEGER,
date_received INTEGER,
mailbox INTEGER NOT NULL,
remote_mailbox INTEGER,
flags INTEGER NOT NULL DEFAULT 0,
read INTEGER NOT NULL DEFAULT 0,
flagged INTEGER NOT NULL DEFAULT 0,
deleted INTEGER NOT NULL DEFAULT 0,
size INTEGER NOT NULL DEFAULT 0,
conversation_id INTEGER NOT NULL DEFAULT 0,
date_last_viewed INTEGER,
list_id_hash INTEGER,
unsubscribe_type INTEGER,
searchable_message INTEGER,
brand_indicator INTEGER,
display_date INTEGER,
flag_color INTEGER,
color TEXT COLLATE BINARY,
type INTEGER,
fuzzy_ancestor INTEGER,
automated_conversation INTEGER DEFAULT 0,
root_status INTEGER DEFAULT -1, is_urgent INTEGER NOT NULL DEFAULT 0);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
total_count INTEGER NOT NULL DEFAULT 0,
unread_count INTEGER NOT NULL DEFAULT 0,
deleted_count INTEGER NOT NULL DEFAULT 0,
unseen_count INTEGER NOT NULL DEFAULT 0,
unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
change_identifier TEXT COLLATE BINARY,
source INTEGER,
alleged_change_identifier TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
comment TEXT COLLATE BINARY NOT NULL,
UNIQUE(address, comment) ON CONFLICT ABORT);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL,
address INTEGER NOT NULL,
type INTEGER,
position INTEGER,
UNIQUE(message, type, position) ON CONFLICT ABORT);
CREATE TABLE attachments (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
attachment_id TEXT COLLATE BINARY,
name TEXT COLLATE BINARY,
UNIQUE(message, attachment_id) ON CONFLICT ABORT);
CREATE TABLE labels (message_id INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE, mailbox_id INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;
CREATE TABLE server_messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
mailbox INTEGER NOT NULL REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
sequence_identifier INTEGER,
read INTEGER NOT NULL,
deleted INTEGER NOT NULL,
replied INTEGER NOT NULL,
flagged INTEGER NOT NULL,
draft INTEGER NOT NULL,
forwarded INTEGER NOT NULL,
redirected INTEGER NOT NULL,
junk_level_set_by_user INTEGER NOT NULL,
junk_level INTEGER NOT NULL,
flag_color INTEGER NOT NULL,
remote_id INTEGER NOT NULL,
UNIQUE(mailbox, remote_id) ON CONFLICT ABORT);
CREATE TABLE server_labels (server_message INTEGER REFERENCES server_messages(ROWID) ON DELETE CASCADE,
label INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
PRIMARY KEY(server_message, label)) WITHOUT ROWID;
CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
flags INTEGER NOT NULL DEFAULT 0,
sync_key TEXT COLLATE BINARY);
CREATE TABLE conversation_id_message_id (conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE ON UPDATE CASCADE,
message_id INTEGER NOT NULL DEFAULT 0,
date_sent INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY(conversation_id, message_id)) WITHOUT ROWID;
CREATE TABLE message_references (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
reference INTEGER NOT NULL DEFAULT 0,
is_originator INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER,
follow_up_start_date INTEGER,
follow_up_end_date INTEGER,
follow_up_jsonstringformodelevaluationforsuggestions TEXT COLLATE BINARY,
read_later_date INTEGER,
send_later_date INTEGER,
validation_state INTEGER NOT NULL DEFAULT 0,
model_category INTEGER,
model_subcategory INTEGER,
category_model_version INTEGER,
category_is_temporary INTEGER,
model_analytics TEXT COLLATE BINARY,
model_high_impact INTEGER NOT NULL DEFAULT 0,
generated_summary INTEGER,
urgent INTEGER, message_id_header TEXT COLLATE BINARY, due_by INTEGER,
UNIQUE(message_id) ON CONFLICT ABORT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
subject TEXT COLLATE RTRIM NOT NULL,
UNIQUE(subject) ON CONFLICT ABORT);
CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary TEXT COLLATE RTRIM NOT NULL,
UNIQUE(summary) ON CONFLICT ABORT);
CREATE TABLE generated_summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary BLOB NOT NULL,
status INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_metadata (message_id INTEGER PRIMARY KEY,
timestamp INTEGER NOT NULL,
json_values TEXT COLLATE BINARY NOT NULL);
CREATE TABLE data_detection_results (ROWID INTEGER PRIMARY KEY,
global_message_id INTEGER NOT NULL,
category TEXT COLLATE BINARY NOT NULL,
value TEXT COLLATE BINARY NOT NULL,
UNIQUE(global_message_id, category, value) ON CONFLICT ABORT);
CREATE TABLE rich_links (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT COLLATE BINARY,
url TEXT COLLATE BINARY NOT NULL,
hash TEXT COLLATE BINARY NOT NULL,
UNIQUE(hash) ON CONFLICT ABORT);
CREATE TABLE message_rich_links (global_message_id INTEGER NOT NULL REFERENCES message_global_data(ROWID) ON DELETE CASCADE,
rich_link INTEGER NOT NULL REFERENCES rich_links(ROWID) ON DELETE CASCADE,
PRIMARY KEY(global_message_id, rich_link)) WITHOUT ROWID;
CREATE TABLE protected_message_data (ROWID INTEGER PRIMARY KEY,
data TEXT COLLATE BINARY);
CREATE TABLE brand_indicators (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
indicator BLOB,
indicator_hash TEXT COLLATE BINARY,
hash_algorithm TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE brand_indicator_evidence (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
brand_indicator INTEGER NOT NULL REFERENCES brand_indicators(ROWID) ON DELETE CASCADE ON UPDATE CASCADE,
url TEXT COLLATE BINARY NOT NULL,
evidence BLOB,
unverified_messages TEXT COLLATE BINARY,
UNIQUE(brand_indicator, url) ON CONFLICT ABORT);
CREATE TABLE address_metadata (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
smime_capabilities TEXT COLLATE NOCASE NOT NULL,
smime_capabilities_date INTEGER NOT NULL,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE businesses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address_comment TEXT COLLATE NOCASE,
domain TEXT COLLATE NOCASE,
brand_id INTEGER,
localized_brand_name TEXT,
UNIQUE(address_comment, domain) ON CONFLICT ABORT,
UNIQUE(brand_id) ON CONFLICT ABORT,
CHECK(((address_comment IS NOT NULL AND domain IS NOT NULL AND brand_id IS NULL AND localized_brand_name IS NULL) OR (address_comment IS NULL AND domain IS NULL AND brand_id IS NOT NULL AND localized_brand_name IS NOT NULL))));
CREATE TABLE business_addresses (ROWID INTEGER PRIMARY KEY,
address INTEGER NOT NULL,
business INTEGER NOT NULL,
category INTEGER,
last_modified INTEGER,
last_bcs_sync INTEGER,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE business_categories (ROWID INTEGER PRIMARY KEY,
business INTEGER NOT NULL,
category INTEGER NOT NULL,
UNIQUE(business) ON CONFLICT ABORT);
CREATE TABLE senders (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
contact_identifier TEXT COLLATE BINARY,
bucket INTEGER NOT NULL DEFAULT 0,
user_initiated INTEGER NOT NULL DEFAULT 1,
UNIQUE(contact_identifier) ON CONFLICT ABORT);
CREATE TABLE sender_addresses (address INTEGER PRIMARY KEY,
sender INTEGER NOT NULL REFERENCES senders(ROWID) ON DELETE CASCADE);
CREATE TABLE events (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE, start_date INTEGER, end_date INTEGER, location TEXT, out_of_date INTEGER DEFAULT 0, processed INTEGER DEFAULT 0, is_all_day INTEGER DEFAULT 0, associated_id_string TEXT, original_receiving_account TEXT, ical_uid TEXT, is_response_requested INTEGER DEFAULT 0);`;

const plist = (value: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${value}</plist>`;

// A text value as the Accounts framework stores a property: a binary
// NSKeyedArchiver archive whose root is the string.
const archived = (text: string) =>
  execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], {
    input: plist(
      `<dict><key>$archiver</key><string>NSKeyedArchiver</string><key>$version</key><integer>100000</integer><key>$top</key><dict><key>root</key><dict><key>CF$UID</key><integer>1</integer></dict></dict><key>$objects</key><array><string>$null</string><string>${text}</string></array></dict>`,
    ),
  });

// The Accounts store with one IMAP account per identifier and address, and
// Mail's store at V10 with the index rows given.
function macUnder(
  home: string,
  accounts: readonly (readonly [string, string])[],
  rows: string,
): void {
  mkdirSync(join(home, 'Library/Accounts'), { recursive: true });
  {
    using store = new DatabaseSync(
      join(home, 'Library/Accounts/Accounts4.sqlite'),
    );
    store.exec(`
      CREATE TABLE ZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACTIVE INTEGER, ZAUTHENTICATED INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZVISIBLE INTEGER, ZWARMINGUP INTEGER, ZACCOUNTTYPE INTEGER, ZPARENTACCOUNT INTEGER, ZDATE TIMESTAMP, ZLASTCREDENTIALRENEWALREJECTIONDATE TIMESTAMP, ZACCOUNTDESCRIPTION VARCHAR, ZAUTHENTICATIONTYPE VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZMODIFICATIONID VARCHAR, ZOWNINGBUNDLEID VARCHAR, ZUSERNAME VARCHAR, ZDATACLASSPROPERTIES BLOB );
      CREATE TABLE Z_2ENABLEDDATACLASSES ( Z_2ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER, PRIMARY KEY (Z_2ENABLEDACCOUNTS, Z_7ENABLEDDATACLASSES) );
      CREATE TABLE Z_2PROVISIONEDDATACLASSES ( Z_2PROVISIONEDACCOUNTS INTEGER, Z_7PROVISIONEDDATACLASSES INTEGER, PRIMARY KEY (Z_2PROVISIONEDACCOUNTS, Z_7PROVISIONEDDATACLASSES) );
      CREATE TABLE ZACCOUNTPROPERTY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZKEY VARCHAR, ZVALUE BLOB );
      CREATE TABLE ZACCOUNTTYPE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOBSOLETE INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZSUPPORTSMULTIPLEACCOUNTS INTEGER, ZVISIBILITY INTEGER, ZACCOUNTTYPEDESCRIPTION VARCHAR, ZCREDENTIALPROTECTIONPOLICY VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZOWNINGBUNDLEID VARCHAR );
      CREATE TABLE ZDATACLASS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNAME BLOB , ZENUMVALUE INTEGER);
      INSERT INTO ZACCOUNTTYPE (Z_PK, ZIDENTIFIER) VALUES (1, 'com.apple.account.IMAP');
    `);
    for (const [index, [identifier, address]] of accounts.entries()) {
      store
        .prepare(
          'INSERT INTO ZACCOUNT (Z_PK, ZACTIVE, ZACCOUNTTYPE, ZACCOUNTDESCRIPTION, ZIDENTIFIER) VALUES (?, 1, 1, ?, ?)',
        )
        .run(index + 1, identifier, identifier);
      store
        .prepare(
          "INSERT INTO ZACCOUNTPROPERTY (ZOWNER, ZKEY, ZVALUE) VALUES (?, 'IdentityEmailAddress', ?)",
        )
        .run(index + 1, archived(address));
    }
  }
  const root = join(home, 'Library/Mail');
  mkdirSync(join(root, 'V10/MailData'), { recursive: true });
  writeFileSync(
    join(root, 'PersistenceInfo.plist'),
    plist(
      '<dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict>',
    ),
  );
  using index = new DatabaseSync(join(root, 'V10/MailData/Envelope Index'));
  index.exec(envelopeIndexSchema);
  index.exec(rows);
}

const january = Date.UTC(2026, 0, 1) / 1000;
const at = (seconds: number) => new Date(seconds * 1000).toISOString();

test('Mail counterparts name who the user wrote To and Cc, who wrote to the user and the user’s own addresses, by address and not by mailbox', async () => {
  await using home = await mkdtempDisposable(
    join(tmpdir(), 'mail-counterparts-'),
  );
  // No mailbox is a Sent mailbox: the user's messages sit in INBOX and
  // Archive. Message 4 has a Date header of 2038, and message 7 no sender.
  macUnder(
    home.path,
    [
      ['WORK', 'Me@Work.example'],
      ['HOME', 'me@home.example'],
    ],
    `
    INSERT INTO mailboxes(ROWID, url) VALUES
      (1, 'imap://WORK/INBOX'), (2, 'imap://WORK/Archive'), (3, 'imap://HOME/INBOX');
    INSERT INTO subjects VALUES (1, 'Hello');
    INSERT INTO addresses VALUES
      (1, 'me@work.example', ''),
      (2, 'ME@WORK.EXAMPLE', 'Me'),
      (3, 'Ann@Example.com', 'Ann'),
      (4, ' ann@example.com', 'Ann Lee'),
      (5, 'bo@example.com', 'Bo'),
      (6, 'BO@example.com', 'Robert'),
      (7, 'cy@example.com', ''),
      (8, 'undisclosed-recipients:;', ''),
      (9, '/o=ExchangeLabs/ou=Exchange Administrative Group/cn=Recipients/cn=Dee', 'Dee'),
      (10, 'eve@example.com', 'Eve'),
      (11, 'news@example.com', 'News');
    INSERT INTO messages(ROWID, global_message_id, subject, mailbox, sender, date_sent, date_received, conversation_id) VALUES
      (1, 1, 1, 1, 1, ${january}, ${january}, 100),
      (2, 2, 1, 2, 2, ${january + 60}, ${january + 60}, 101),
      (3, 3, 1, 1, 1, ${january + 120}, ${january + 120}, 101),
      (4, 4, 1, 1, 5, 2147483647, ${january + 180}, 102),
      (5, 5, 1, 1, 6, ${january + 230}, ${january + 240}, 103),
      (6, 6, 1, 3, 7, ${january + 300}, ${january + 300}, 104),
      (7, 7, 1, 1, NULL, ${january + 360}, ${january + 360}, 105);
    INSERT INTO recipients(ROWID, message, address, type, position) VALUES
      (1, 1, 3, 0, 0), (2, 1, 5, 1, 0),
      (3, 2, 3, 0, 0), (4, 2, 8, 0, 1), (5, 2, 9, 1, 0),
      (6, 3, 4, 0, 0), (7, 3, 4, 0, 1),
      (8, 4, 1, 0, 0), (9, 4, 10, 1, 0),
      (10, 7, 11, 0, 0);
    `,
  );
  const connector = await connectorUnder(home.path);

  const database = await importAll(connector, join(home.path, 'Apple'));

  const row = (
    relation: string,
    identifier: string,
    name: string | null,
    first: number | null,
    last: number | null,
    occurrences: number,
    conversations: number,
  ) => ({
    relation,
    identifier_type: identifier.includes('@') ? 'email' : 'app',
    identifier,
    linked_type: null,
    linked_identifier: null,
    name,
    first_at: first === null ? null : at(first),
    last_at: last === null ? null : at(last),
    occurrences,
    context: JSON.stringify({ conversations }),
  });
  assert.deepEqual(
    read(database, 'SELECT * FROM counterparts ORDER BY relation, identifier'),
    [
      // An Exchange directory name is no email address, but Mail shows its
      // name.
      row(
        'cc',
        '/o=exchangelabs/ou=exchange administrative group/cn=recipients/cn=dee',
        'Dee',
        january + 60,
        january + 60,
        1,
        1,
      ),
      row('cc', 'bo@example.com', 'Bo', january, january, 1, 1),
      // One name each, so the latest wins; the Date header of 2038 is not
      // when Mail received the message.
      row(
        'received',
        'bo@example.com',
        'Robert',
        january + 180,
        january + 240,
        2,
        2,
      ),
      row(
        'received',
        'cy@example.com',
        null,
        january + 300,
        january + 300,
        1,
        1,
      ),
      // An address the user never sent from is still the user's.
      row('self', 'me@home.example', null, null, null, 0, 0),
      // Each spelling of the address the user sent from, in any mailbox.
      row('self', 'me@work.example', 'Me', january, january + 120, 3, 2),
      // Both spellings of Ann's address are one row, named as most messages
      // name her, though the last lists her twice as Ann Lee.
      row('sent', 'ann@example.com', 'Ann', january, january + 120, 3, 2),
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
