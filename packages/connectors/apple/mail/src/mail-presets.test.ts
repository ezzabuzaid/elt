import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type {
  AppleConnector,
  Preset,
} from '@workspace/connector-apple-connector/apple-connector';
import { Pipeline } from '@workspace/elt';
import { SQLiteSyncHistory, installSQLiteCatalog } from '@workspace/elt-sqlite';

// This package's folder, which holds its manifest and presets.
const folder = fileURLToPath(new URL('..', import.meta.url));

// Mail reads its store under HOME when its module loads, so the connector is
// imported only after HOME points at the test's folder. node --test runs this
// file in its own process, so the module loads once, under that HOME.
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

// The import the plugin makes: one pass into data.sqlite with sync history and
// catalog, metadata only, so the attachments view has no attachmentRef.
async function importMail(
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
// read-only, with the preset loaded through -cmd. A failing statement fails
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

// A message file as Mail keeps one: the MIME's byte length, the MIME, then
// Mail's own property list.
const emlx = (lines: readonly string[]) => {
  const mime = lines.join('\r\n');
  return `${Buffer.byteLength(mime)}      \n${mime}${plist('<dict><key>flags</key><integer>1</integer></dict>')}`;
};

const january = Date.UTC(2026, 0, 1) / 1000;

test('mail_messages reads each message with its body, recipients, subject, Message-ID and attachments', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'mail-presets-'),
  );
  const root = join(scratch.path, 'Library/Mail');
  const mailbox = join(root, 'V10/ACCOUNT/Inbox.mbox');
  mkdirSync(join(scratch.path, 'Library/Accounts'), { recursive: true });
  {
    using accounts = new DatabaseSync(
      join(scratch.path, 'Library/Accounts/Accounts4.sqlite'),
    );
    accounts.exec(`
      CREATE TABLE ZACCOUNT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZACTIVE INTEGER, ZAUTHENTICATED INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZVISIBLE INTEGER, ZWARMINGUP INTEGER, ZACCOUNTTYPE INTEGER, ZPARENTACCOUNT INTEGER, ZDATE TIMESTAMP, ZLASTCREDENTIALRENEWALREJECTIONDATE TIMESTAMP, ZACCOUNTDESCRIPTION VARCHAR, ZAUTHENTICATIONTYPE VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZMODIFICATIONID VARCHAR, ZOWNINGBUNDLEID VARCHAR, ZUSERNAME VARCHAR, ZDATACLASSPROPERTIES BLOB );
      CREATE TABLE Z_2ENABLEDDATACLASSES ( Z_2ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER, PRIMARY KEY (Z_2ENABLEDACCOUNTS, Z_7ENABLEDDATACLASSES) );
      CREATE TABLE Z_2PROVISIONEDDATACLASSES ( Z_2PROVISIONEDACCOUNTS INTEGER, Z_7PROVISIONEDDATACLASSES INTEGER, PRIMARY KEY (Z_2PROVISIONEDACCOUNTS, Z_7PROVISIONEDDATACLASSES) );
      CREATE TABLE ZACCOUNTPROPERTY ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOWNER INTEGER, ZKEY VARCHAR, ZVALUE BLOB );
      CREATE TABLE ZACCOUNTTYPE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOBSOLETE INTEGER, ZSUPPORTSAUTHENTICATION INTEGER, ZSUPPORTSMULTIPLEACCOUNTS INTEGER, ZVISIBILITY INTEGER, ZACCOUNTTYPEDESCRIPTION VARCHAR, ZCREDENTIALPROTECTIONPOLICY VARCHAR, ZCREDENTIALTYPE VARCHAR, ZIDENTIFIER VARCHAR, ZOWNINGBUNDLEID VARCHAR );
      CREATE TABLE ZDATACLASS ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNAME BLOB , ZENUMVALUE INTEGER);
      INSERT INTO ZACCOUNTTYPE (Z_PK, ZIDENTIFIER) VALUES (1, 'com.apple.account.IMAP');
      INSERT INTO ZACCOUNT (Z_PK, ZACTIVE, ZACCOUNTTYPE, ZACCOUNTDESCRIPTION, ZIDENTIFIER, ZUSERNAME) VALUES (1, 1, 1, 'Work', 'ACCOUNT', 'me@example.com');
    `);
  }
  mkdirSync(join(mailbox, 'UUID/Data/Messages'), { recursive: true });
  mkdirSync(join(root, 'V10/MailData'), { recursive: true });
  writeFileSync(
    join(root, 'PersistenceInfo.plist'),
    plist(
      '<dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict>',
    ),
  );
  writeFileSync(
    join(mailbox, 'Info.plist'),
    plist('<dict><key>MailboxID</key><string>INBOX</string></dict>'),
  );
  const message = (id: number, lines: readonly string[]) =>
    writeFileSync(
      join(mailbox, 'UUID/Data/Messages', `${id}.emlx`),
      emlx(lines),
    );
  // Plain text and HTML of one message: a reader gets the plain text.
  message(1, [
    'From: Ann <ann@example.com>',
    'Subject: Re: Budget',
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Numbers attached.',
    '--b',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<p>Numbers attached.</p>',
    '--b--',
    '',
  ]);
  // HTML only: a reader gets the HTML as it is.
  message(2, [
    'From: Bo <bo@example.com>',
    'Subject: Newsletter',
    'Content-Type: text/html; charset=UTF-8',
    '',
    '<h1>News</h1>',
  ]);
  // Two text parts around three attachments: one whose detached file is not
  // on this Mac, and a forwarded message whose text is not this message's.
  message(3, [
    'From: ann@example.com',
    'Subject: Invoice',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Part one',
    '--m',
    'Content-Type: application/pdf',
    'Content-Disposition: attachment; filename="invoice.pdf"',
    'X-Apple-Content-Length: 12',
    '',
    '--m',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    'Part two',
    '--m',
    'Content-Type: text/csv',
    'Content-Disposition: attachment; filename="rows.csv"',
    '',
    'a,b',
    '--m',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="forwarded.eml"',
    '',
    'From: carol@example.com',
    'Subject: Earlier',
    '',
    'Forwarded text',
    '--m--',
    '',
  ]);
  // Message 4 has no file on this Mac: Mail keeps only its index row.
  {
    using index = new DatabaseSync(join(root, 'V10/MailData/Envelope Index'));
    index.exec(envelopeIndexSchema);
    index.exec(`
      INSERT INTO mailboxes(ROWID, url) VALUES (1, 'imap://ACCOUNT/INBOX');
      INSERT INTO addresses VALUES
        (1, 'ann@example.com', 'Ann'),
        (2, 'me@example.com', 'Me'),
        (3, 'bo@example.com', '');
      INSERT INTO subjects VALUES (1, 'Budget'), (2, 'Newsletter'), (3, 'Invoice'), (4, 'Offline');
      INSERT INTO message_global_data(ROWID, message_id, message_id_header) VALUES
        (11, 1, '<m1@example.com>'), (12, 2, '<m2@example.com>'),
        (13, 3, '<m3@example.com>'), (14, 4, '<m4@example.com>');
      INSERT INTO messages(ROWID, message_id, global_message_id, subject, subject_prefix, mailbox, sender,
          date_sent, date_received, read, flagged, conversation_id) VALUES
        (1, 1, 11, 1, 'Re: ', 1, 1, ${january}, ${january + 60}, 1, 1, 7),
        (2, 2, 12, 2, NULL, 1, 3, NULL, ${january + 120}, 0, 0, 8),
        (3, 3, 13, 3, NULL, 1, 1, ${january + 180}, ${january + 180}, 1, 0, 9),
        (4, 4, 14, 4, NULL, 1, 3, ${january + 240}, ${january + 240}, 0, 0, 10);
      INSERT INTO recipients VALUES
        (1, 1, 2, 0, 0), (2, 1, 3, 1, 0), (3, 1, 1, 0, 1),
        (4, 2, 2, 0, 0), (5, 3, 2, 0, 0);
    `);
  }

  const connector = await connectorUnder(scratch.path);
  const database = await importMail(connector, join(scratch.path, 'import'));
  const presets = connector.presets();
  const mailMessages = presets.find(({ name }) => name === 'mail_messages');
  assert.ok(mailMessages, 'Mail has the mail_messages preset');
  const rows = read(
    database,
    presets,
    'SELECT * FROM mail_messages ORDER BY id',
  );

  for (const preset of presets) {
    const columns = read(
      database,
      presets,
      `SELECT name FROM pragma_table_info('${preset.name}')`,
    ).map(({ name }) => name);
    assert.deepEqual(
      described(preset),
      [preset.name, ...columns],
      `${preset.file} describes its view and every column, in order`,
    );
  }
  const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString();
  const recipient = (address: string, name: string | null, kind: string) => ({
    address,
    name,
    kind,
  });
  assert.deepEqual(
    rows.map((row) => ({
      ...row,
      recipients: JSON.parse(String(row.recipients)),
      attachments: JSON.parse(String(row.attachments)),
    })),
    [
      {
        id: '1',
        received_at: timestamp(january + 60),
        sent_at: timestamp(january),
        mailbox: '1',
        mailbox_url: 'imap://ACCOUNT/INBOX',
        conversation_id: '7',
        read: 1,
        flagged: 1,
        deleted: 0,
        sender: 'ann@example.com',
        sender_name: 'Ann',
        recipients: [
          recipient('me@example.com', 'Me', 'to'),
          recipient('ann@example.com', 'Ann', 'to'),
          recipient('bo@example.com', null, 'cc'),
        ],
        subject: 'Re: Budget',
        message_id_header: '<m1@example.com>',
        body: 'Numbers attached.',
        attachments: [],
      },
      {
        id: '2',
        received_at: timestamp(january + 120),
        sent_at: null,
        mailbox: '1',
        mailbox_url: 'imap://ACCOUNT/INBOX',
        conversation_id: '8',
        read: 0,
        flagged: 0,
        deleted: 0,
        sender: 'bo@example.com',
        sender_name: null,
        recipients: [recipient('me@example.com', 'Me', 'to')],
        subject: 'Newsletter',
        message_id_header: '<m2@example.com>',
        body: '<h1>News</h1>',
        attachments: [],
      },
      {
        id: '3',
        received_at: timestamp(january + 180),
        sent_at: timestamp(january + 180),
        mailbox: '1',
        mailbox_url: 'imap://ACCOUNT/INBOX',
        conversation_id: '9',
        read: 1,
        flagged: 0,
        deleted: 0,
        sender: 'ann@example.com',
        sender_name: 'Ann',
        recipients: [recipient('me@example.com', 'Me', 'to')],
        subject: 'Invoice',
        message_id_header: '<m3@example.com>',
        body: 'Part one\nPart two',
        attachments: [
          {
            part_id: '2',
            filename: 'invoice.pdf',
            content_type: 'application/pdf',
            declared_bytes: 12,
            available_locally: false,
          },
          {
            part_id: '4',
            filename: 'rows.csv',
            content_type: 'text/csv',
            declared_bytes: null,
            available_locally: true,
          },
          {
            part_id: '5',
            filename: 'forwarded.eml',
            content_type: 'message/rfc822',
            declared_bytes: null,
            available_locally: true,
          },
        ],
      },
      {
        id: '4',
        received_at: timestamp(january + 240),
        sent_at: timestamp(january + 240),
        mailbox: '1',
        mailbox_url: 'imap://ACCOUNT/INBOX',
        conversation_id: '10',
        read: 0,
        flagged: 0,
        deleted: 0,
        sender: 'bo@example.com',
        sender_name: null,
        recipients: [],
        subject: 'Offline',
        message_id_header: '<m4@example.com>',
        body: null,
        attachments: [],
      },
    ],
  );
});
