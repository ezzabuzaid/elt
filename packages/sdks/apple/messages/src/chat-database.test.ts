import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { MissingColumnsError } from '@zukhruf/sqlite-snapshot';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { MessagesStore } from './index.ts';

test('a chat.db without a column the reader needs fails with MissingColumnsError naming each missing column', async () => {
  await using dir = await new TemporaryFiles().directory('chat-db-');
  const path = join(dir.path, 'chat.db');
  // A store from a macOS whose message table lacks a column this reader loads
  // and whose other tables are missing entirely.
  using app = open(path, { journal: new RollbackJournal() });
  app.exec(
    'CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT)',
  );

  assert.throws(
    () => new MessagesStore({ path, home: dir.path }).open(),
    (error: unknown) => {
      assert.ok(error instanceof MissingColumnsError);
      assert.match(error.message, /message\.handle_id/);
      assert.match(error.message, /message\.attributedBody/);
      assert.match(error.message, /chat\.guid/);
      assert.match(error.message, /attachment\.filename/);
      assert.doesNotMatch(error.message, /message\.text\b/);
      return true;
    },
  );
});
