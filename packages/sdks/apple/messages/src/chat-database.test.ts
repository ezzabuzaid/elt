import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { MessagesSchemaError, MessagesStore } from './index.ts';

test('a chat.db without a column the reader needs fails with MessagesSchemaError naming each missing column', async () => {
  await using dir = await mkdtempDisposable(join(tmpdir(), 'chat-db-'));
  const path = join(dir.path, 'chat.db');
  // A store from a macOS whose message table lacks a column this reader loads
  // and whose other tables are missing entirely.
  using app = new DatabaseSync(path);
  app.exec(
    'CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT)',
  );

  assert.throws(
    () => new MessagesStore(path).open(),
    (error: unknown) => {
      assert.ok(error instanceof MessagesSchemaError);
      assert.match(error.message, /message\.handle_id/);
      assert.match(error.message, /message\.attributedBody/);
      assert.match(error.message, /chat\.guid/);
      assert.match(error.message, /attachment\.filename/);
      assert.doesNotMatch(error.message, /message\.text\b/);
      return true;
    },
  );
});
