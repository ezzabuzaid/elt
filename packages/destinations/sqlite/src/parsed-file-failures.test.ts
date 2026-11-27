import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';

import {
  Catalog,
  type ChangeSignal,
  Connection,
  Copy,
  DocumentParser,
  EscalatedFailure,
  Gauge,
  Pipeline,
  PipelineError,
  Source,
  Stream,
} from '@eltjs/elt';

import { SQLiteDestination, SQLiteSyncHistory } from './index.ts';

// The upstream of the test source, which never changes: a watch reads it
// once, at its start.
class Still extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

const documents = new Stream({
  name: 'documents',
  jsonSchema: {
    type: 'object',
    description: 'A document with a file.',
    properties: { id: { type: 'string', description: 'Document id.' } },
    required: ['id'],
  },
  primaryKey: ['id'],
  supportedSyncModes: ['full_refresh'],
  supportsFileTransfer: true,
});

// Gives one document for each file in files, with the file's path.
class Documents extends Source {
  readonly identity = 'documents';
  protected readonly catalog = new Catalog([documents]);
  readonly #files: readonly string[];

  constructor(files: readonly string[]) {
    super();
    this.#files = files;
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  override changeSignals(streams: readonly Stream[]): ChangeSignal[] {
    return [{ gauge: new Still(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract() {
    for (const [index, file] of this.#files.entries())
      yield { stream: 'documents', data: { id: String(index) }, file };
  }
}

// A parser of UTF-8 text that throws what failure gives for a file, as
// MacOSDocumentParser throws the EscalatedFailure of a deprecated pool.
class TextParser extends DocumentParser {
  readonly #failure: (path: string) => Error | undefined;

  constructor(failure: (path: string) => Error | undefined) {
    super('text-v1');
    this.#failure = failure;
  }

  async parse(path: string): Promise<string> {
    const failure = this.#failure(path);
    if (failure !== undefined) throw failure;
    return readFile(path, 'utf8');
  }
}

// A pipeline that copies a document for each file into the table documents
// of a SQLite file, with the text that parser reads from the file.
async function parsedImport(
  directory: string,
  parser: DocumentParser,
  names: readonly string[],
) {
  const files = names.map((name) => join(directory, name));
  for (const file of files) await writeFile(file, `text of ${file}`);
  const source = new Documents(files);
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  return {
    files,
    pipeline: new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'documents',
          source,
          destination,
          steps: [
            new Copy(
              documents,
              destination.table('documents', (c) => [
                c.text('id'),
                c.text('content').from(documents.file).parse(parser),
              ]),
            ),
          ],
        }),
      ],
    }),
    read: (sql: string) => {
      const { stdout } = spawnSync(
        '/usr/bin/sqlite3',
        ['-readonly', '-json', destination.path, sql],
        { encoding: 'utf8' },
      );
      return JSON.parse(stdout || '[]');
    },
  };
}

const copies =
  'SELECT a.status AS attempt, a.failure_type, c.status AS copy FROM sync_attempts a JOIN extraction_coverage c USING (attempt_id)';

test('under a watch, a file whose parse escalates a failure ends the watch with that failure, and the sync history records no failed copy', async (t) => {
  await using scratch = await new TemporaryFiles().directory('elt-parsed-');
  const escalated = new EscalatedFailure(new Error('a newer host runs'));
  const imported = await parsedImport(
    scratch.path,
    new TextParser((path) => (path.endsWith('b.txt') ? escalated : undefined)),
    ['a.txt', 'b.txt'],
  );
  const controller = new AbortController();
  const ended = Array.fromAsync(
    imported.pipeline.watch({ signal: controller.signal }),
  ).then(
    () => 'the watch ended with no failure',
    (error: unknown) => error,
  );
  // A watch that holds the failure watches on, to load the copy again
  // later: once a pass ended, the test stops it.
  const held = new AbortController();
  const holding = waitFor(
    () => {
      assert.ok(
        imported
          .read(copies)
          .some(({ attempt }: { attempt: string }) => attempt !== 'running'),
        'no pass ended',
      );
    },
    { signal: AbortSignal.any([t.signal, held.signal]), interval: 10 },
  ).then(() => controller.abort());

  let error;
  try {
    error = await ended;
  } finally {
    held.abort();
    controller.abort();
    await holding.catch((failure: unknown) => {
      if (failure !== held.signal.reason) throw failure;
    });
  }

  assert.equal(error, escalated);
  assert.deepEqual(imported.read(copies), [
    { attempt: 'cancelled', failure_type: null, copy: 'cancelled' },
  ]);
});

test('a run whose parse of a file escalates a failure rejects with that failure, and the sync history records no failed copy', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parsed-');
  const escalated = new EscalatedFailure(new Error('a newer host runs'));
  const imported = await parsedImport(
    scratch.path,
    new TextParser((path) => (path.endsWith('b.txt') ? escalated : undefined)),
    ['a.txt', 'b.txt'],
  );

  const error = await imported.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.equal(error, escalated);
  assert.deepEqual(imported.read(copies), [
    { attempt: 'cancelled', failure_type: null, copy: 'cancelled' },
  ]);
});

test('a run whose parse of a file fails with an error that is not escalated records the copy failed with why, and rejects with a PipelineError', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parsed-');
  const imported = await parsedImport(
    scratch.path,
    new TextParser((path) =>
      path.endsWith('b.txt') ? new Error('b.txt is damaged') : undefined,
    ),
    ['a.txt', 'b.txt'],
  );

  const error = await imported.pipeline.run().then(
    () => assert.fail('the run reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(error instanceof PipelineError, String(error));
  assert.equal(
    error.message,
    'The following copies did not load completely: documents: b.txt is damaged',
  );
  assert.deepEqual(imported.read(copies), [
    { attempt: 'failed', failure_type: 'system', copy: 'failed' },
  ]);
});
