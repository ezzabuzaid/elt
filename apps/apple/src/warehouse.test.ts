import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { PipelineError, type Source } from 'elt';
import { appleWarehouse } from './fixtures/apple-warehouse.ts';
import { noteBody, noteStoreFixture } from './fixtures/notes-store.ts';
import { AppleCalendarSource } from './sources/apple-calendar/apple-calendar-source.ts';
import { AppleContactsSource } from './sources/apple-contacts/apple-contacts-source.ts';
import { AppleMailSource } from './sources/apple-mail/apple-mail-source.ts';
import { AppleMessagesSource } from './sources/apple-messages/apple-messages-source.ts';
import { AppleNotesSource } from './sources/apple-notes/apple-notes-source.ts';
import { AppleRemindersSource } from './sources/apple-reminders/apple-reminders-source.ts';
import { AppleSafariSource } from './sources/apple-safari/apple-safari-source.ts';
import { warehouseConnection } from './warehouse-connection.ts';

const sources: Record<string, Source> = {
  mail: new AppleMailSource('/nonexistent/Mail'),
  notes: new AppleNotesSource(),
  messages: new AppleMessagesSource(),
  contacts: new AppleContactsSource(),
  calendar: new AppleCalendarSource({
    startAt: '2000-01-01T00:00:00.000Z',
    endAt: '2001-01-01T00:00:00.000Z',
  }),
  reminders: new AppleRemindersSource(),
  safari: new AppleSafariSource(),
};

test('every Apple stream has one documented reader view named after its source and stream', async () => {
  const names: string[] = [];
  const undocumented: string[] = [];
  for (const [name, source] of Object.entries(sources)) {
    const connection = await warehouseConnection(name, source, {
      url: 'postgres://warehouse@127.0.0.1:55432/warehouse',
      outputs: '/nonexistent/outputs',
    });
    for (const copy of connection.steps) {
      names.push(`${copy.to.readerView?.schema}.${copy.to.readerView?.name}`);
      try {
        connection.destination.validate(copy.configuration, copy.to);
      } catch (error) {
        undocumented.push(String(error));
      }
    }
  }

  assert.deepEqual(undocumented, []);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('marts.notes_inline_attachments'));
  assert.ok(names.includes('marts.messages_chat_handles'));
  assert.ok(names.includes('marts.calendar_ics_components'));
  assert.ok(names.includes('marts.safari_history_visits'));
});

test('Notes reads as documented views that follow edits and deletions without being recreated', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-marts-'));
  const path = await noteStoreFixture(join(scratch.path, 'native'));
  await using warehouse = await appleWarehouse(
    'notes',
    new AppleNotesSource({ path }),
    join(scratch.path, 'outputs'),
  );
  const { agent } = warehouse;
  await warehouse.load();

  assert.deepEqual(
    (
      await agent`SELECT name FROM catalog WHERE kind = 'view' AND name LIKE 'notes%' ORDER BY name`
    ).map(({ name }) => name),
    [
      'notes_accounts',
      'notes_attachments',
      'notes_folders',
      'notes_inline_attachments',
      'notes_notes',
    ],
  );
  assert.deepEqual(
    [
      ...(await agent`SELECT kind, name FROM catalog WHERE coalesce(description, '') = ''`),
    ],
    [],
  );
  assert.deepEqual(
    (
      await agent`SELECT name, data_type FROM catalog
        WHERE name IN ('notes_notes.locked', 'notes_notes.modifiedAt', 'notes_attachments.attachmentRef', 'notes_notes.loaded_at')
        ORDER BY name`
    ).map((found) => ({ ...found })),
    [
      { name: 'notes_attachments.attachmentRef', data_type: 'text' },
      { name: 'notes_notes.loaded_at', data_type: 'timestamp with time zone' },
      { name: 'notes_notes.locked', data_type: 'boolean' },
      { name: 'notes_notes.modifiedAt', data_type: 'timestamp with time zone' },
    ],
  );
  assert.deepEqual(
    (
      await agent`SELECT n.id, n.locked, n.text IS NULL AS unreadable, f.type AS folder_type
        FROM notes_notes n JOIN notes_folders f ON f.id = n."folderId" ORDER BY n.id`
    ).map((found) => ({ ...found })),
    [
      { id: 'NOTE-LOCKED', locked: true, unreadable: true, folder_type: '0' },
      { id: 'NOTE-RICH', locked: false, unreadable: false, folder_type: '0' },
      {
        id: 'NOTE-TRASHED',
        locked: false,
        unreadable: false,
        folder_type: '1',
      },
    ],
  );
  assert.deepEqual(
    (
      await agent`SELECT i.id FROM notes_inline_attachments i
        JOIN notes_notes n ON n.id = i."noteId" WHERE n.id = 'NOTE-RICH' ORDER BY i.id`
    ).map(({ id }) => id),
    ['INLINE-LINK', 'INLINE-TAG'],
  );
  const files = Object.fromEntries(
    (
      await agent`SELECT id, "attachmentRef" FROM notes_attachments WHERE id IN ('ATT-FILE', 'ATT-PHOTO')`
    ).map(({ id, attachmentRef }) => [id, attachmentRef]),
  );
  assert.equal(await readFile(files['ATT-FILE'], 'utf8'), 'attached words');
  assert.equal(files['ATT-PHOTO'], null);
  await assert.rejects(
    agent`SELECT * FROM apple_notes.raw_notes`,
    /permission denied for schema apple_notes/,
  );

  const views = async () =>
    (
      await warehouse.sql`SELECT c.relname::text AS name, c.oid::int AS oid FROM pg_class c
        WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind = 'v' AND c.relname LIKE 'notes%' ORDER BY 1`
    ).map((found) => ({ ...found }));
  const installed = await views();
  {
    using notes = new DatabaseSync(path);
    notes
      .prepare('UPDATE ZICNOTEDATA SET ZDATA = ? WHERE Z_PK = 4')
      .run(noteBody([{ text: 'Old\nrestored\n' }]));
    notes.exec(
      "UPDATE ZICCLOUDSYNCINGOBJECT SET ZMARKEDFORDELETION = 1 WHERE ZIDENTIFIER IN ('ATT-PHOTO', 'NOTE-LOCKED')",
    );
  }
  await warehouse.load();

  assert.deepEqual(
    (await agent`SELECT id, text FROM notes_notes ORDER BY id`).map(
      (found) => ({ ...found }),
    ),
    [
      {
        id: 'NOTE-RICH',
        text: 'Groceries\nMilk\nEggs\nBuy fresh\nsee site\n\n\ntag #food\nlink Old',
      },
      { id: 'NOTE-TRASHED', text: 'Old\nrestored' },
    ],
  );
  assert.deepEqual(
    (await agent`SELECT id FROM notes_attachments ORDER BY id`).map(
      ({ id }) => id,
    ),
    ['ATT-FILE', 'ATT-TABLE'],
  );
  assert.deepEqual(await views(), installed);
});

test('a Notes store that cannot be read publishes nothing, and an empty one publishes empty views', async () => {
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'notes-marts-'));
  const path = await noteStoreFixture(join(scratch.path, 'native'));
  {
    using notes = new DatabaseSync(path);
    notes.exec('DELETE FROM ZICCLOUDSYNCINGOBJECT; DELETE FROM ZICNOTEDATA');
  }
  await using missing = await appleWarehouse(
    'notes',
    new AppleNotesSource({ path: join(scratch.path, 'missing.sqlite') }),
    join(scratch.path, 'outputs'),
  );
  await using empty = await appleWarehouse(
    'notes',
    new AppleNotesSource({ path }),
    join(scratch.path, 'outputs'),
  );

  await assert.rejects(missing.load(), PipelineError);
  await empty.load();

  assert.deepEqual(
    [
      ...(await missing.agent`SELECT name FROM catalog WHERE name LIKE 'notes%'`),
    ],
    [],
  );
  assert.deepEqual(
    (await missing.agent`SELECT status FROM sync_status`).map(
      ({ status }) => status,
    ),
    ['failed'],
  );
  assert.deepEqual(
    (
      await empty.agent`
        SELECT (SELECT count(*) FROM notes_notes)::int AS notes,
          (SELECT count(*) FROM notes_attachments)::int AS attachments`
    ).map((found) => ({ ...found })),
    [{ notes: 0, attachments: 0 }],
  );
});
