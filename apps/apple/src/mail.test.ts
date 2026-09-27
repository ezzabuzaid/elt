import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtempDisposable,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { Copy, Pipeline, PipelineError } from 'elt';
import { MarkdownDestination } from 'elt-markdown';
import {
  SQLiteCheckpointStore,
  SQLiteColumns,
  SQLiteDestination,
} from 'elt-sqlite';
import { MacOSDocumentParser } from './parsers/macos-document-parser.ts';
import {
  MailSchemaError,
  MailUnavailableError,
} from './platform/macos/mail-store.ts';
import osa from './platform/macos/osa.ts';
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';

// Mail 16.0 on macOS 26.6.2: schema only, with no personal records or triggers.
const schema = `PRAGMA journal_mode = WAL;
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
download_state INTEGER NOT NULL DEFAULT 0,
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
urgent INTEGER, message_id_header TEXT COLLATE BINARY,
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

const xml = (value: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${value}</plist>`;
const digest = (value: Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
const embedded =
  'From: nested@example.test\r\nSubject: nested\r\n\r\nForwarded body\r\n';
const mime = [
  'From: Example <sender@example.test>',
  'To: reader@example.test',
  'Message-ID: <fixture@example.test>',
  'Subject: =?UTF-8?B?SGVsbG8g8J+MjQ==?=',
  'Received: first',
  'Received: second',
  'X-Empty:',
  'X-Unicode: مرحبا',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="outer"',
  '',
  '--outer',
  'Content-Type: multipart/alternative; boundary="inner"',
  '',
  '--inner',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hello =F0=9F=8C=8D',
  '--inner',
  'Content-Type: text/html; charset=UTF-8',
  '',
  '<p>Hello 🌍</p>',
  '--inner--',
  '--outer',
  'Content-Type: application/pdf',
  'Content-Disposition: attachment; filename="detached.pdf"',
  'X-Apple-Content-Length: 12',
  '',
  '--outer',
  'Content-Type: application/zip',
  'Content-Disposition: attachment; filename="missing.zip"',
  'X-Apple-Content-Length: 4',
  '',
  '--outer',
  'Content-Type: message/rfc822',
  'Content-Disposition: attachment; filename="forwarded.eml"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from(embedded).toString('base64'),
  '--outer',
  'Content-Type: image/png',
  'Content-Disposition: inline; filename="tiny.png"',
  'Content-ID: <image>',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from([0, 1, 2, 255]).toString('base64'),
  '--outer--',
  '',
].join('\r\n');
const emlx = Buffer.from(
  `${Buffer.byteLength(mime)}      \n${mime}${xml('<dict><key>flags</key><integer>1</integer></dict>')}`,
);

async function fixture(root: string) {
  const data = join(root, 'V10/ACCOUNT/Inbox.mbox/UUID/Data');
  await mkdir(join(data, 'Messages'), { recursive: true });
  await mkdir(join(root, 'V10/MailData/Signatures'), { recursive: true });
  await mkdir(join(data, 'Attachments/1/2'), { recursive: true });
  await writeFile(
    join(root, 'PersistenceInfo.plist'),
    xml(
      '<dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict>',
    ),
  );
  await writeFile(join(data, 'Messages/1.partial.emlx'), emlx);
  await writeFile(
    join(data, 'Messages/999.emlx'),
    'orphan file is not a live message',
  );
  await writeFile(join(data, 'Attachments/1/2/detached.pdf'), '%PDF-fixture');
  await writeFile(
    join(root, 'V10/ACCOUNT/Inbox.mbox/Info.plist'),
    xml('<dict><key>MailboxID</key><string>INBOX</string></dict>'),
  );
  await writeFile(
    join(root, 'V10/MailData/SyncedRules.plist'),
    xml(
      '<array><dict><key>RuleId</key><string>rule</string><key>RuleName</key><string>Example</string><key>Criteria</key><array><dict><key>Header</key><string>Subject</string><key>Qualifier</key><string>Contains</string><key>Expression</key><string>hello</string></dict></array></dict></array>',
    ),
  );
  await writeFile(
    join(root, 'V10/MailData/RulesActiveState.plist'),
    xml('<dict><key>rule</key><true/></dict>'),
  );
  await writeFile(
    join(root, 'V10/MailData/SyncedSmartMailboxes.plist'),
    xml(
      '<array><dict><key>MailboxID</key><string>parent</string><key>MailboxChildren</key><array><dict><key>MailboxID</key><string>smart</string><key>MailboxCriteria</key><array><dict><key>Header</key><string>From</string></dict></array></dict></array></dict></array>',
    ),
  );
  await writeFile(
    join(root, 'V10/MailData/Signatures/example.mailsignature'),
    'Content-Type: text/html\r\n\r\n<b>Signature</b>',
  );
  using db = new DatabaseSync(join(root, 'V10/MailData/Envelope Index'));
  db.exec(schema);
  db.exec(`
    INSERT INTO mailboxes(ROWID,url) VALUES(1,'imap://ACCOUNT/INBOX'),(2,'local://LOCAL/Archive');
    INSERT INTO addresses VALUES(1,'sender@example.test','Example');
    INSERT INTO subjects VALUES(1,'Hello 🌍');
    INSERT INTO summaries VALUES(1,'Hello');
    INSERT INTO message_global_data(ROWID,message_id,message_id_header) VALUES(1,9223372036854775800,'<fixture@example.test>');
    INSERT INTO messages(ROWID,message_id,global_message_id,subject,summary,mailbox,sender,date_sent,date_received,list_id_hash) VALUES(1,9223372036854775800,1,1,1,1,1,1735787045,1735787046,-9223372036854775800),(2,2,1,1,1,1,1,NULL,NULL,NULL);
    UPDATE messages SET document_id=X'0102' WHERE ROWID=1;
    INSERT INTO recipients VALUES(1,1,1,0,0),(2,999,1,0,0);
    INSERT INTO attachments VALUES(1,1,'2','detached.pdf'),(2,1,'3','missing.zip'),(3,2,'1','not-downloaded.txt');
    INSERT INTO labels VALUES(1,1),(1,2);
    INSERT INTO conversations VALUES(1,0,'sync');
    INSERT INTO conversation_id_message_id VALUES(1,9223372036854775800,1735787045);
    INSERT INTO message_references VALUES(1,1,-9223372036854775800,0);
    INSERT INTO generated_summaries VALUES(1,X'010203',0);
    INSERT INTO message_metadata VALUES(1,123,'{}');
    INSERT INTO data_detection_results VALUES(1,1,'url','https://example.test');
    INSERT INTO rich_links VALUES(1,'Example','https://example.test','hash');
    INSERT INTO message_rich_links VALUES(1,1);
    INSERT INTO protected_message_data VALUES(1,'native payload');
    INSERT INTO brand_indicators VALUES(1,'https://example.test/logo',X'0506','digest','sha256');
    INSERT INTO brand_indicator_evidence VALUES(1,1,'https://example.test/cert',X'0708',NULL);
    INSERT INTO address_metadata VALUES(1,'sender@example.test','native',123);
    INSERT INTO businesses VALUES(1,NULL,NULL,9223372036854775800,'Example');
    INSERT INTO business_addresses VALUES(1,1,1,3,123,1735787045.125);
    INSERT INTO business_categories VALUES(1,1,3);
    INSERT INTO senders VALUES(1,'contact',0,1);
    INSERT INTO sender_addresses VALUES(1,1);
    INSERT INTO events(ROWID,message_id,start_date) VALUES(1,1,123);
    INSERT INTO server_messages VALUES(1,1,1,1,0,0,0,0,0,0,0,0,0,0,42);
    INSERT INTO server_labels VALUES(1,1);
  `);
  return { data, root, index: join(root, 'V10/MailData/Envelope Index') };
}

function rows(path: string, sql: string) {
  using db = new DatabaseSync(path, { readOnly: true });
  return db
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}
function bytes(path: string, table: string, file: unknown) {
  return Buffer.concat(
    rows(
      path,
      `SELECT bytes FROM "_mac_elt_files_${table}_bytes" WHERE file = ${Number(file)} ORDER BY n`,
    ).map((row) => row.bytes as Uint8Array),
  );
}
async function pipeline(source: AppleMailSource, directory: string) {
  const destination = new SQLiteDestination({
    path: join(directory, 'out.sqlite'),
  });
  const { streams } = await source.discover();
  return new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(directory, 'state.sqlite'),
    }),
    steps: streams.map(
      (stream) =>
        new Copy(
          stream,
          stream.supportsFileTransfer
            ? destination.table(stream.name, (columns) => [
                ...SQLiteColumns.fromSchema(stream.jsonSchema),
                columns.blob('bytes').from(stream.file),
              ])
            : destination.table(stream.name),
          {
            id: stream.name,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            primaryKey: [...stream.primaryKey],
          },
        ),
    ),
  });
}

test('Mail exports the native store, MIME, detached files and unavailable metadata; snapshots update and delete', async (t) => {
  t.mock.method(osa, 'execute', async () =>
    JSON.stringify({
      accounts: [{ id: 'ACCOUNT', name: 'Synthetic' }],
      smtpServers: [{ name: 'Synthetic SMTP' }],
    }),
  );
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource(store.root);
  const run = await pipeline(source, dir.path);
  const out = join(dir.path, 'out.sqlite');
  const first = await run.run();
  assert.equal(first.length, 42);
  assert.ok(first.every((result) => result.count > 0));
  assert.equal(
    rows(out, 'SELECT messageId FROM messages WHERE id=1')[0]?.messageId,
    '9223372036854775800',
  );
  assert.equal(
    rows(out, 'SELECT listIdHash FROM messages WHERE id=1')[0]?.listIdHash,
    '-9223372036854775800',
  );
  assert.equal(
    rows(out, 'SELECT dateSent FROM messages WHERE id=1')[0]?.dateSent,
    '2025-01-02T03:04:05.000Z',
  );
  assert.equal(
    rows(out, 'SELECT lastBcsSync FROM businessAddresses')[0]?.lastBcsSync,
    '2025-01-02T03:04:05.125Z',
  );
  assert.equal(
    rows(out, 'SELECT count(*) AS n FROM messageMailboxes')[0]?.n,
    2,
  );
  assert.equal(rows(out, 'SELECT count(*) AS n FROM recipients')[0]?.n, 2);
  assert.deepEqual(
    rows(
      out,
      "SELECT value FROM messageHeaders WHERE name='received' ORDER BY position",
    ),
    [{ value: 'first' }, { value: 'second' }],
  );
  assert.equal(
    rows(out, "SELECT value FROM messageHeaders WHERE name='subject'")[0]
      ?.value,
    'Hello 🌍',
  );
  assert.match(
    String(
      rows(out, "SELECT text FROM messageParts WHERE partId='1.1'")[0]?.text,
    ),
    /Hello 🌍/,
  );
  assert.equal(rows(out, 'SELECT enabled FROM rules')[0]?.enabled, 1);
  assert.equal(
    rows(out, "SELECT parentId FROM smartMailboxes WHERE id='smart'")[0]
      ?.parentId,
    'parent',
  );
  assert.equal(
    rows(out, 'SELECT summaryBase64 FROM generatedSummaries')[0]?.summaryBase64,
    'AQID',
  );
  const attachments = rows(
    out,
    'SELECT * FROM attachments ORDER BY messageId,partId',
  );
  assert.equal(attachments.length, 5);
  assert.equal(attachments[0]?.sha256, digest(Buffer.from('%PDF-fixture')));
  assert.equal(
    bytes(out, 'attachments', attachments[0]?.bytes).toString(),
    '%PDF-fixture',
  );
  assert.equal(attachments[1]?.availableLocally, 0);
  assert.equal(attachments[1]?.bytes, null);
  assert.equal(
    bytes(out, 'attachments', attachments[2]?.bytes).toString(),
    embedded,
  );
  assert.deepEqual(
    bytes(out, 'attachments', attachments[3]?.bytes),
    Buffer.from([0, 1, 2, 255]),
  );
  assert.equal(attachments[4]?.availableLocally, 0);
  const original = rows(out, 'SELECT * FROM messageFiles WHERE messageId=1')[0];
  assert.deepEqual(bytes(out, 'messageFiles', original?.bytes), emlx);
  assert.equal(
    rows(out, 'SELECT availableLocally FROM messageFiles WHERE messageId=2')[0]
      ?.availableLocally,
    0,
  );
  assert.ok(
    (await run.run()).every(
      (result) => result.count === 0 && result.deleted === 0,
    ),
  );

  using upstream = new DatabaseSync(store.index);
  upstream.exec(
    'UPDATE messages SET read=1 WHERE ROWID=1; DELETE FROM labels WHERE mailbox_id=2',
  );
  await writeFile(
    join(store.data, 'Attachments/1/2/detached.pdf'),
    '%PDF-updated',
  );
  await mkdir(join(store.data, 'Attachments/1/3'), { recursive: true });
  await writeFile(
    join(store.data, 'Attachments/1/3/missing.zip'),
    Buffer.from([1, 2, 3, 4]),
  );
  const downloaded =
    'Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="not-downloaded.txt"\r\n\r\ndownloaded';
  await writeFile(
    join(store.data, 'Messages/2.emlx'),
    `${Buffer.byteLength(downloaded)}\n${downloaded}`,
  );
  const second = await run.run();
  assert.equal(second.find((x) => x.copy.from === source.messages)?.count, 1);
  assert.equal(
    second.find((x) => x.copy.from === source.attachments)?.count,
    3,
  );
  assert.equal(
    second.find((x) => x.copy.from === source.messageMailboxes)?.deleted,
    1,
  );
  assert.equal(
    rows(out, "SELECT availableLocally FROM attachments WHERE partId='3'")[0]
      ?.availableLocally,
    1,
  );
  assert.equal(
    bytes(
      out,
      'attachments',
      rows(out, "SELECT bytes FROM attachments WHERE partId='2'")[0]?.bytes,
    ).toString(),
    '%PDF-updated',
  );
  assert.equal(
    rows(
      out,
      "SELECT availableLocally FROM attachments WHERE messageId='2' AND partId='1'",
    )[0]?.availableLocally,
    1,
  );
  assert.equal(
    rows(out, "SELECT count(*) AS n FROM attachments WHERE messageId='2'")[0]
      ?.n,
    1,
  );
  upstream.exec(
    'DELETE FROM messages WHERE ROWID=1; DELETE FROM attachments WHERE message=1; DELETE FROM labels WHERE message_id=1',
  );
  const third = await run.run();
  assert.equal(third.find((x) => x.copy.from === source.messages)?.deleted, 1);
  assert.equal(
    third.find((x) => x.copy.from === source.attachments)?.deleted,
    4,
  );
  assert.equal(
    third.find((x) => x.copy.from === source.messageParts)?.deleted,
    8,
  );
  assert.ok(
    (await run.run()).every(
      (result) => result.count === 0 && result.deleted === 0,
    ),
  );
});

test('Mail failures keep stored rows and checkpoints; absent stores and unknown schemas fail explicitly', async (t) => {
  t.mock.method(osa, 'execute', async () =>
    JSON.stringify({ accounts: [], smtpServers: [] }),
  );
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-errors-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource(store.root);
  const run = await pipeline(source, dir.path);
  await run.run();
  const before = rows(
    join(dir.path, 'state.sqlite'),
    "SELECT * FROM checkpoints WHERE id='attachments'",
  );
  await writeFile(
    join(store.data, 'Messages/1.partial.emlx'),
    '99999\ntruncated',
  );
  await assert.rejects(
    run.run(),
    (error) =>
      error instanceof PipelineError &&
      error.results.some(
        (x) =>
          x.copy.from === source.attachments &&
          x.failures.some((f) => f.error instanceof MailSchemaError),
      ),
  );
  assert.equal(
    rows(
      join(dir.path, 'out.sqlite'),
      'SELECT count(*) AS n FROM attachments',
    )[0]?.n,
    5,
  );
  // Checkpoints for the failed MIME streams are unchanged even if unrelated metadata commits.
  assert.deepEqual(
    rows(
      join(dir.path, 'state.sqlite'),
      "SELECT * FROM checkpoints WHERE id='attachments'",
    ),
    before,
  );
  using upstream = new DatabaseSync(store.index);
  upstream.exec(
    'ALTER TABLE messages RENAME COLUMN flags TO unrecognized_flags',
  );
  await assert.rejects(
    run.run(),
    (error) =>
      error instanceof PipelineError && error.cause instanceof MailSchemaError,
  );
  await mkdir(join(dir.path, 'missing-output'));
  const missing = await pipeline(
    new AppleMailSource(join(dir.path, 'absent')),
    join(dir.path, 'missing-output'),
  );
  await assert.rejects(
    missing.run(),
    (error) =>
      error instanceof PipelineError &&
      error.cause instanceof MailUnavailableError,
  );
});

test('Mail watches index commits and file-only downloads, cancels, and exports readable Markdown', async (t) => {
  t.mock.method(osa, 'execute', async () =>
    JSON.stringify({ accounts: [], smtpServers: [] }),
  );
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-watch-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const source = new AppleMailSource(store.root);
  const abort = new AbortController();
  const watch = source.watch({
    streams: [source.messages, source.attachments],
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
  });
  assert.deepEqual((await watch.next()).value, [
    source.messages,
    source.attachments,
  ]);
  using upstream = new DatabaseSync(store.index);
  upstream.exec('UPDATE messages SET flagged=1 WHERE ROWID=1');
  assert.deepEqual((await watch.next()).value, [
    source.messages,
    source.attachments,
  ]);
  await writeFile(
    join(store.data, 'Attachments/1/2/detached.pdf'),
    '%PDF-changed',
  );
  assert.deepEqual((await watch.next()).value, [
    source.messages,
    source.attachments,
  ]);
  abort.abort();
  assert.equal((await watch.next()).done, true);
  const destination = new MarkdownDestination({
    path: join(dir.path, 'markdown'),
  });
  await new Pipeline({
    source,
    destination,
    steps: [
      new Copy(source.messageParts, destination.file('parts.md'), {
        syncMode: 'full_refresh',
        destinationSyncMode: 'overwrite',
      }),
    ],
  }).run();
  const files = await readdir(join(dir.path, 'markdown'), { recursive: true });
  const contents = await Promise.all(
    files
      .filter((name) => name.endsWith('.md'))
      .map((name) => readFile(join(dir.path, 'markdown', name), 'utf8')),
  );
  assert.ok(contents.some((text) => text.includes('Hello 🌍')));
});

test('Mail tracking pixels load their original bytes with null OCR text', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'elt-mail-pixels-'));
  const store = await fixture(join(dir.path, 'Mail'));
  const images = [];
  for (const width of [1, 2, 3]) {
    const chunk = (type: string, data: Buffer) => {
      const label = Buffer.from(type);
      const result = Buffer.alloc(data.length + 12);
      result.writeUInt32BE(data.length);
      label.copy(result, 4);
      data.copy(result, 8);
      result.writeUInt32BE(
        crc32(Buffer.concat([label, data])),
        data.length + 8,
      );
      return result;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(width, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const pixels = Buffer.concat(
      Array.from({ length: width }, () =>
        Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]),
      ),
    );
    images.push(
      Buffer.concat([
        Buffer.from('89504e470d0a1a0a', 'hex'),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(pixels)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
  }
  const raw = [
    'Content-Type: multipart/mixed; boundary="pixels"',
    '',
    ...images.flatMap((bytes, i) => [
      '--pixels',
      'Content-Type: image/png',
      `Content-Disposition: inline; filename="${i}.png"`,
      'Content-Transfer-Encoding: base64',
      '',
      bytes.toString('base64'),
    ]),
    '--pixels--',
    '',
  ].join('\r\n');
  await writeFile(
    join(store.data, 'Messages/1.partial.emlx'),
    `${Buffer.byteLength(raw)}\n${raw}`,
  );
  using upstream = new DatabaseSync(store.index);
  upstream.exec('DELETE FROM attachments');
  const source = new AppleMailSource(store.root);
  const destination = new SQLiteDestination({
    path: join(dir.path, 'images.sqlite'),
  });
  await new Pipeline({
    source,
    destination,
    steps: [
      new Copy(
        source.attachments,
        destination.table('images', (columns) => [
          ...SQLiteColumns.fromSchema(source.attachments.jsonSchema),
          columns
            .text('content')
            .from(source.attachments.file)
            .parse(new MacOSDocumentParser()),
          columns.blob('bytes').from(source.attachments.file),
        ]),
      ),
    ],
  }).run();
  const output = rows(
    destination.path,
    'SELECT content,bytes FROM images ORDER BY partId',
  );
  assert.equal(output.length, 3);
  for (const [i, row] of output.entries()) {
    assert.equal(row.content, null);
    assert.deepEqual(bytes(destination.path, 'images', row.bytes), images[i]);
  }
});
