import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { Settings } from '@workspace/settings';

import { AppleTranscription } from './apple-transcription.ts';
import { AttachmentText } from './attachment-text.ts';

test('an existing attachment reader observes a model saved or disabled by another host', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'transcription-host-'),
  );
  const audio = join(directory.path, 'voice.opus');
  const database = join(directory.path, 'data.sqlite');
  await writeFile(audio, Buffer.from([0, 1, 2, 3]));
  using data = new DatabaseSync(database);
  data.exec(
    'CREATE TABLE files (attachmentRef TEXT); CREATE VIEW documents AS SELECT * FROM files',
  );
  data.prepare('INSERT INTO files VALUES (?)').run(audio);
  await using host = new AppleTranscription(directory.path);
  using other = new Settings(directory.path);
  const reader = new AttachmentText(database, ['documents'], () => host.parser);
  await reader.update(new AbortController().signal);
  assert.equal(
    data.prepare('SELECT status FROM attachment_text').get()?.status,
    'no_text',
  );
  other.setTranscription({ engine: 'cohere', directory: '/missing-cohere' });
  const identity = await host.parser.identityFor(audio);
  assert.ok(identity?.includes('cohere'));
  // The real decoder fails on these deliberately corrupt bytes. Its failure
  // proves that the already-constructed reader used the newly enabled model.
  await reader.update(new AbortController().signal);
  assert.equal(
    data.prepare('SELECT status FROM attachment_text').get()?.status,
    'failed',
  );
  other.setTranscription({ engine: 'canary', directory: '/missing-canary' });
  assert.notEqual(await host.parser.identityFor(audio), identity);
  other.setTranscription(null);
  await reader.update(new AbortController().signal);
  assert.equal(
    data.prepare('SELECT status FROM attachment_text').get()?.status,
    'no_text',
  );
});
