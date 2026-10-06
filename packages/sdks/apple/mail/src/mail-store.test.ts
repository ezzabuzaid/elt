import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MailSchemaError, MailStore } from './index.ts';

test('an index without a column the reader needs fails with MailSchemaError naming each missing table.column', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'mail-store-'));
  await writeFile(
    join(dir.path, 'PersistenceInfo.plist'),
    '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>LastUsedVersionDirectoryName</key><string>V10</string></dict></plist>',
  );
  await mkdir(join(dir.path, 'V10/MailData'), { recursive: true });
  const index = join(dir.path, 'V10/MailData/Envelope Index');
  // An index from a Mail whose messages table lacks columns this reader
  // loads and whose other tables are missing entirely.
  using app = new DatabaseSync(index);
  app.exec(
    'CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, message_id INTEGER, subject INTEGER)',
  );

  await assert.rejects(new MailStore(dir.path).open(), (error: unknown) => {
    assert.ok(error instanceof MailSchemaError);
    assert.equal(error.name, 'MailSchemaError');
    assert.ok(
      error.message.startsWith(
        `The Mail index at ${index} has a layout this reader does not read (missing messages.global_message_id, messages.remote_id, `,
      ),
    );
    assert.match(error.message, /\bmailboxes\.url\b/);
    assert.match(error.message, /\bserver_labels\.label\b/);
    assert.match(error.message, /\bevents\.is_response_requested\)\.$/);
    assert.doesNotMatch(
      error.message,
      /[ (]messages\.(ROWID|message_id|subject)\b/,
    );
    return true;
  });
});
