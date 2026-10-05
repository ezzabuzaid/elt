import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('..', import.meta.url));

test('subscription evidence combines read-only imports without confusing their messages or attachments, retains lifecycle records and explains multilingual and attachment matches', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'subscription-presets-'),
  );
  const mail = join(scratch.path, 'mail.sqlite');
  const messages = join(scratch.path, 'messages.sqlite');
  const notes = join(scratch.path, 'notes.sqlite');

  // Fixtures at the imported-view boundary, including metadata-only imports
  // without attachmentRef. The existing mail-presets test runs the real Mail
  // source and pipeline and checks the mail_messages projection underneath.
  {
    using database = new DatabaseSync(mail);
    database.exec(`
      CREATE TABLE messages (id TEXT);
      CREATE TABLE evidence_mail (
        id TEXT, received_at TEXT, sender TEXT, subject TEXT, body TEXT,
        attachments TEXT, mailbox_url TEXT, conversation_id TEXT,
        message_id_header TEXT, recipients TEXT, deleted INTEGER
      );
      INSERT INTO evidence_mail VALUES
        ('1', '2026-01-01T00:00:00.000Z', 'billing@example.com', 'ANNUAL RECEIPT', '<p>Paid $20</p>', '[]', 'imap://A/INBOX', '7', '<receipt@example.com>', '[]', 0),
        ('2', '2026-02-01T00:00:00.000Z', 'billing@example.com', 'Cancellation confirmed', 'Your plan has ended.', '[]', 'imap://A/INBOX', '7', '<cancel@example.com>', '[]', 0),
        ('3', NULL, 'offers@example.com', 'Try Grok Bot', 'Free trial invitation', '[]', 'imap://B/INBOX', '8', NULL, '[]', 0),
        ('4', NULL, 'billing@example.com', 'Documents', NULL, '[{"part_id":"2","filename":"invoice.pdf","available_locally":false}]', 'imap://A/INBOX', '9', NULL, '[]', 1),
        ('5', NULL, 'friend@example.com', 'Dinner', 'See you tonight', '[]', 'imap://A/INBOX', '10', NULL, '[]', 0);
    `);
  }
  {
    using database = new DatabaseSync(messages);
    database.exec(`
      CREATE TABLE messages (guid TEXT, date TEXT, handle TEXT, handleService TEXT, subject TEXT, text TEXT, isFromMe INTEGER, service TEXT);
      CREATE TABLE message_attachments (messageGuid TEXT, attachmentGuid TEXT);
      CREATE TABLE attachments (guid TEXT, transferName TEXT, mimeType TEXT, availableLocally INTEGER);
      INSERT INTO messages VALUES
        ('1', '2026-03-01T00:00:00.000Z', 'Zain', 'SMS', NULL, 'تم تجديد اشتراكك الشهري', 0, 'SMS'),
        ('2', NULL, 'Bank', 'SMS', NULL, 'Card charged at an unknown merchant', 0, 'SMS'),
        ('3', NULL, 'Friend', 'iMessage', NULL, 'See you tomorrow', 1, 'iMessage'),
        ('4', NULL, 'Merchant', 'SMS', NULL, NULL, 0, 'SMS');
      INSERT INTO attachments VALUES ('a', 'receipt.pdf', 'application/pdf', 0), ('b', 'photo.jpg', 'image/jpeg', 1);
      INSERT INTO message_attachments VALUES ('4', 'a'), ('4', 'b');
    `);
  }
  {
    using database = new DatabaseSync(notes);
    database.exec(`
      CREATE TABLE notes (id TEXT, title TEXT, text TEXT, markdown TEXT, modifiedAt TEXT, accountId TEXT, folderId TEXT, locked INTEGER);
      CREATE TABLE attachments (id TEXT, noteId TEXT, filename TEXT, type TEXT, availableLocally INTEGER, summary TEXT, ocrText TEXT, handwritingText TEXT, transcript TEXT);
      INSERT INTO notes VALUES
        ('1', 'Subscriptions', NULL, NULL, '2026-04-01T00:00:00.000Z', 'A', 'F', 1),
        ('2', 'Scanned paperwork', NULL, NULL, '2026-05-01T00:00:00.000Z', 'B', 'F', 0),
        ('3', 'Hiking', 'Bring water', 'Bring water', NULL, 'A', 'F', 0);
      INSERT INTO attachments VALUES
        ('scan', '2', 'scan.png', 'public.png', 0, NULL, 'Membership expires in June', NULL, NULL),
        ('transcript', '2', 'audio.m4a', 'public.audio', 1, NULL, NULL, NULL, 'تجديد الاشتراك');
    `);
  }

  const mailPreset = join(folder, 'presets/mail_subscription_evidence.sql');
  const messagesPreset = join(
    folder,
    '../messages/presets/message_subscription_evidence.sql',
  );
  const notesPreset = join(
    folder,
    '../notes/presets/note_subscription_evidence.sql',
  );
  const files = [mailPreset, messagesPreset, notesPreset];
  // Each connector normally opens as main. For one connection over multiple
  // imports, bind its explicit main. references to that attached database.
  const commands = [
    `ATTACH '${messages}' AS sms`,
    `ATTACH '${notes}' AS note_store`,
    'CREATE TEMP VIEW mail_messages AS SELECT * FROM main.evidence_mail',
    readFileSync(mailPreset, 'utf8'),
    readFileSync(messagesPreset, 'utf8').replaceAll('main.', 'sms.'),
    readFileSync(notesPreset, 'utf8').replaceAll('main.', 'note_store.'),
  ];
  const before = [mail, messages, notes].map((file) => readFileSync(file));
  const result = spawnSync(
    '/usr/bin/sqlite3',
    [
      '-readonly',
      '-json',
      '-cmd',
      '.timeout 30000',
      '-cmd',
      'PRAGMA temp_store = MEMORY',
      ...commands.flatMap((sql) => ['-cmd', sql]),
      mail,
      `SELECT * FROM mail_subscription_evidence
       UNION ALL SELECT * FROM message_subscription_evidence
       UNION ALL SELECT * FROM note_subscription_evidence
       ORDER BY source, record_id`,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const rows: Record<string, unknown>[] = JSON.parse(result.stdout);
  assert.deepEqual(
    rows.map(({ source, record_id }) => [source, record_id]),
    [
      ['mail', '1'],
      ['mail', '2'],
      ['mail', '3'],
      ['mail', '4'],
      ['messages', '1'],
      ['messages', '2'],
      ['messages', '4'],
      ['notes', '1'],
      ['notes', '2'],
    ],
  );
  const row = (source: string, id: string) => {
    const found = rows.find(
      (item) => item.source === source && item.record_id === id,
    );
    assert.ok(found);
    return found;
  };
  assert.deepEqual(JSON.parse(String(row('mail', '1').matched_terms)).sort(), [
    'annual',
    'receipt',
  ]);
  assert.equal(row('mail', '1').text, '<p>Paid $20</p>');
  assert.equal(row('mail', '3').correspondent, 'offers@example.com');
  assert.equal(row('mail', '4').text, null);
  assert.equal(JSON.parse(String(row('mail', '4').context)).deleted, 1);
  assert.ok(
    JSON.parse(String(row('messages', '1').matched_terms)).includes('اشتراك'),
  );
  assert.equal(row('messages', '1').text, 'تم تجديد اشتراكك الشهري');
  assert.equal(JSON.parse(String(row('messages', '4').attachments)).length, 2);
  assert.equal(
    JSON.parse(String(row('messages', '4').attachments))[0].available_locally,
    false,
  );
  assert.equal(row('notes', '1').text, null);
  assert.equal(JSON.parse(String(row('notes', '1').context)).locked, 1);
  assert.equal(row('notes', '1').occurred_at, '2026-04-01T00:00:00.000Z');
  assert.equal(row('notes', '1').date_kind, 'modified');
  assert.match(String(row('notes', '2').text), /Membership expires in June/);
  assert.match(String(row('notes', '2').text), /تجديد الاشتراك/);

  for (const file of files) {
    const described = [...readFileSync(file, 'utf8').matchAll(/^-- (\w+): /gm)]
      .slice(1)
      .map(([, column]) => column);
    assert.deepEqual(described, Object.keys(row('mail', '1')));
  }
  assert.deepEqual(
    [mail, messages, notes].map((file) => readFileSync(file)),
    before,
    'loading and querying presets leaves every imported database unchanged',
  );
});
