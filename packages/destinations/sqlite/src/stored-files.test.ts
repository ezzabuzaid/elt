import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';

import {
  Catalog,
  Connection,
  Copy,
  type FailureType,
  Gauge,
  LocalFiles,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  Stream,
} from '@eltjs/elt';

import { SQLiteDestination, SQLiteSyncHistory } from './index.ts';

// The upstream of a test source, which the test fills before it reads: a
// watch finds it changed at its first check and unchanged after.
class Filled extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

test('stored file scopes flush when empty and remain usable across empty, null and populated loads', async () => {
  const stream = new Stream({
    name: 'files',
    jsonSchema: {
      description: 'One files record.',
      type: 'object',
      properties: { id: { description: 'Id of the record.', type: 'string' } },
    },
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
    override changeSignals(streams: readonly Stream[]) {
      return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
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
    clock: globalThis,
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
    using database = open(destination.path, { readOnly: true });
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
  // The history keeps the row that the overwrite removed, and so its file.
  assert.equal(await readFile(stored, 'utf8'), 'attachment');
  await pipeline.run();
  assert.deepEqual(loaded(), []);
});

// A source of one record whose file is at the path that the test gives; it
// calls each error of its own config, so a failure type of system shows that
// the pipeline asked the file storage.
class OneFile extends Source {
  readonly identity = 'one-file';
  readonly files = new Stream({
    name: 'files',
    jsonSchema: {
      description: 'One files record.',
      type: 'object',
      properties: { id: { description: 'Id of the record.', type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
    supportsFileTransfer: true,
  });
  protected readonly catalog = new Catalog([this.files]);
  readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }
  override async currentAsOf() {
    return null;
  }
  protected override async open() {
    return new AsyncDisposableStack();
  }
  override changeSignals(streams: readonly Stream[]) {
    return [{ gauge: new Filled(), streams, interval: 1000, timeout: 1000 }];
  }
  override failureType(): FailureType {
    return 'config';
  }
  protected override async *extract() {
    yield { stream: 'files', data: { id: 'a' }, file: this.path };
  }
}

// A pipeline that stores the file of source in files.
function storing(folder: string, source: OneFile, files: LocalFiles) {
  const destination = new SQLiteDestination({
    path: join(folder, 'out.sqlite'),
  });
  return new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        steps: [
          new Copy(
            source.files,
            destination.table('files', (c) => [
              c.text('id'),
              c.text('ref').from(source.files.file.store(files)),
            ]),
          ),
        ],
      }),
    ],
  });
}

// The failure types of a run that stores the file of source in files.
async function storedFailures(
  folder: string,
  source: OneFile,
  files: LocalFiles,
) {
  const failure = await storing(folder, source, files)
    .run()
    .then(
      () => assert.fail('the run succeeded'),
      (error: unknown) => error,
    );
  assert.ok(failure instanceof PipelineError, String(failure));
  return failure.results.flatMap(({ failures }) =>
    failures.map(({ failureType }) => failureType),
  );
}

test(
  'a file storage whose folder this process may not write fails the copy with the failure type config',
  {
    skip:
      process.platform === 'win32' || process.getuid?.() === 0
        ? 'the folder mode must deny writes to this process'
        : false,
  },
  async () => {
    await using scratch = await new TemporaryFiles().directory(
      'elt-denied-files-',
    );
    const path = join(scratch.path, 'source.txt');
    await writeFile(path, 'attachment');
    const folder = join(scratch.path, 'files');
    await mkdir(folder, { mode: 0o500 });
    // The scratch folder removes what is in it only when it may write it.
    await using _writable = {
      [Symbol.asyncDispose]: () => chmod(folder, 0o700),
    };

    assert.deepEqual(
      await storedFailures(
        scratch.path,
        new (class extends OneFile {
          override failureType(): FailureType {
            return 'system';
          }
        })(path),
        new LocalFiles({ directory: folder }),
      ),
      ['config'],
    );
  },
);

test('a file storage that fails for another reason, such as a folder in a scope that holds only files, fails the copy with the failure type system and a clear with its own error, and a source file that cannot be read fails the copy with the failure type of the source', async () => {
  await using scratch = await new TemporaryFiles().directory(
    'elt-broken-files-',
  );
  const path = join(scratch.path, 'source.txt');
  await writeFile(path, 'attachment');
  const files = new LocalFiles({ directory: join(scratch.path, 'files') });
  const stored = await storedFailures(
    scratch.path,
    new OneFile(join(scratch.path, 'missing.txt')),
    files,
  );
  const [scope] = await readdir(join(files.directory, '.elt-files'));
  assert.ok(scope);
  await mkdir(join(files.directory, '.elt-files', scope, 'folder'));

  assert.deepEqual(
    [stored, await storedFailures(scratch.path, new OneFile(path), files)],
    [['config'], ['system']],
  );
  await assert.rejects(
    storing(scratch.path, new OneFile(path), files).clear(),
    {
      name: 'TypeError',
      message: /Managed attachment is not a regular file/,
    },
  );
});
