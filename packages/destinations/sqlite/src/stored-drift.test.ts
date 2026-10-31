import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
  readPassStatus,
} from './index.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

// Two records behind a cursor, so a run that resumes its checkpoint reads
// none and one that starts over reads both.
class Counting extends LiveSource {
  readonly identity = 'counting';
  readonly records = new Stream({
    name: 'records',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
  });
  protected readonly catalog = new Catalog([this.records]);

  override coverage() {
    return {
      description: 'Two records with an increasing cursor.',
      selection: {},
    };
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *observe({ streams }: SourceWatchOptions) {
    yield streams;
  }

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ): AsyncGenerator<SourceMessage> {
    const cursor = typeof state === 'number' ? state : 0;
    for (let id = cursor + 1; id <= 2; id++) {
      yield { stream: configuration.stream.name, data: { id } };
      yield { type: 'STATE', stream: configuration.stream.name, state: id };
    }
  }
}

// An import as the Apple hosts keep one: data.sqlite with its sync history,
// and checkpoints.sqlite beside it.
function importIn(directory: string) {
  const source = new Counting();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'counting',
        source,
        destination,
        steps: [
          new Copy(source.records, destination.table('records'), {
            id: 'records',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
        checkpoints: new SQLiteCheckpointStore({
          path: join(directory, 'checkpoints.sqlite'),
        }),
      }),
    ],
    history,
  });
  return {
    path: destination.path,
    checkpoints: join(directory, 'checkpoints.sqlite'),
    // How many records the pass read.
    pass: async () => {
      const [result] = await pipeline.run();
      return result?.count;
    },
  };
}

function edit(path: string, sql: string): void {
  using database = new DatabaseSync(path);
  database.exec(sql);
}

test('a checkpoints table another version declared otherwise is replaced, so its copies start over', async () => {
  await using scratch = await new TemporaryFiles().directory('drift-');
  const imported = importIn(scratch.path);
  await imported.pass();
  edit(
    imported.checkpoints,
    `DROP TABLE checkpoints;
    CREATE TABLE checkpoints (id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL) STRICT`,
  );

  assert.equal(await imported.pass(), 2);
});

test('a sync history view another version installed reads as no status, and the next pass installs it again with the history kept', async () => {
  await using scratch = await new TemporaryFiles().directory('drift-');
  const imported = importIn(scratch.path);
  await imported.pass();
  // An older sync_status, without current_as_of.
  edit(
    imported.path,
    `DROP VIEW sync_status;
    CREATE VIEW sync_status AS SELECT "connector", "status", "started_at", "completed_at", "error", "failure_type", NULL AS "last_successful_sync_at" FROM "_elt_sync_attempts"`,
  );

  const older = readPassStatus(imported.path);
  await imported.pass();
  const current = readPassStatus(imported.path);

  assert.deepEqual(older, { pass: null, streams: [] });
  assert.equal(current.pass?.state, 'succeeded');
  using data = new DatabaseSync(imported.path, { readOnly: true });
  assert.equal(
    data.prepare('SELECT count(*) AS n FROM sync_attempts').get()?.n,
    2,
  );
});

test('a sync history table another version declared otherwise is replaced with its history when the next pass installs it', async () => {
  await using scratch = await new TemporaryFiles().directory('drift-');
  const imported = importIn(scratch.path);
  await imported.pass();
  // An older table of checks, without checked_at.
  edit(
    imported.path,
    `DROP TABLE "_elt_stream_checks";
    CREATE TABLE "_elt_stream_checks" ("connector" TEXT NOT NULL, "stream" TEXT NOT NULL, PRIMARY KEY ("connector", "stream")) STRICT`,
  );

  await imported.pass();

  assert.equal(readPassStatus(imported.path).pass?.state, 'succeeded');
  using data = new DatabaseSync(imported.path, { readOnly: true });
  assert.equal(
    data.prepare('SELECT count(*) AS n FROM sync_attempts').get()?.n,
    1,
  );
});
