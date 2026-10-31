import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  Connection,
  Copy,
  LocalFiles,
  Pipeline,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import { SQLiteDestination, SQLiteSyncHistory } from './index.ts';

test('stored file scopes flush when empty and remain usable across empty, null and populated loads', async () => {
  const stream = new Stream({
    name: 'files',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  class FilesSource extends Source {
    readonly identity = 'stored-files-test';
    protected readonly catalog = new Catalog([stream]);
    messages: SourceMessage[] = [];

    override coverage() {
      return { description: 'test', selection: {} };
    }
    override async currentAsOf() {
      return null;
    }
    protected override async open() {
      return new AsyncDisposableStack();
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* this.messages;
    }
  }

  await using scratch = await new TemporaryFiles().directory(
    'elt-empty-files-',
  );
  const source = new FilesSource();
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  await files.flush('unused');
  await files.flush('unused');
  await assert.rejects(readdir(files.directory), { code: 'ENOENT' });
  await writeFile(files.directory, 'not a directory');
  await assert.rejects(files.flush('unused'), { code: 'ENOTDIR' });
  await rm(files.directory);

  const destination = new SQLiteDestination({
    path: join(scratch.path, 'out.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  const pipeline = new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            stream,
            destination.table('files', (c) => [
              c.text('id'),
              c.text('ref').from(stream.file.store(files)),
            ]),
          ),
        ],
      }),
    ],
  });
  const loaded = () => {
    using database = new DatabaseSync(destination.path, { readOnly: true });
    return database
      .prepare('SELECT id, ref FROM files ORDER BY id')
      .all()
      .map(({ id, ref }) => ({ id, ref }));
  };

  await pipeline.run();
  assert.deepEqual(loaded(), []);
  source.messages = [{ stream: 'files', data: { id: 'a' }, file: null }];
  await pipeline.run();
  assert.deepEqual(loaded(), [{ id: 'a', ref: null }]);
  await assert.rejects(readdir(files.directory), { code: 'ENOENT' });

  const path = join(scratch.path, 'source.txt');
  await writeFile(path, 'attachment');
  source.messages = [{ stream: 'files', data: { id: 'a' }, file: path }];
  await pipeline.run();
  const populated = loaded();
  assert.equal(populated.length, 1);
  const row = populated[0];
  assert.ok(row);
  assert.equal(row.id, 'a');
  assert.ok(typeof row.ref === 'string');
  const stored = join(files.directory, row.ref);
  assert.equal(await readFile(stored, 'utf8'), 'attachment');
  await pipeline.run();
  assert.deepEqual(loaded(), populated);

  source.messages = [];
  await pipeline.run();
  assert.deepEqual(loaded(), []);
  await assert.rejects(readFile(stored), { code: 'ENOENT' });
  await pipeline.run();
  assert.deepEqual(loaded(), []);
});
