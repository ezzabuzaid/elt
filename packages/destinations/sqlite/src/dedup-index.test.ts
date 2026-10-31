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
} from './index.ts';

// A source whose upstream is current whenever it is read.
abstract class LiveSource<
  Context extends AsyncDisposable = AsyncDisposable,
> extends Source<Context> {
  override async currentAsOf() {
    return null;
  }
}

// Two records, then a checkpoint on every pass, as a snapshot source saves its
// snapshot even when a pass finds nothing new.
class Checkpointing extends LiveSource {
  readonly identity = 'checkpointing';
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
    return { description: 'Two records, read once.', selection: {} };
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
    if (state === null)
      for (const id of [1, 2])
        yield { stream: configuration.stream.name, data: { id } };
    yield { type: 'STATE', stream: configuration.stream.name, state: 2 };
  }
}

test('a deduplicating load that finds nothing new leaves the database schema as it was', async () => {
  await using scratch = await new TemporaryFiles().directory('dedup-index-');
  const source = new Checkpointing();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'data.sqlite'),
  });
  const history = new SQLiteSyncHistory();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'checkpointing',
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
          path: join(scratch.path, 'checkpoints.sqlite'),
        }),
      }),
    ],
    history,
  });
  const schemaVersion = () => {
    using data = new DatabaseSync(destination.path, { readOnly: true });
    return data.prepare('PRAGMA schema_version').get()?.schema_version;
  };
  await pipeline.run();
  const before = schemaVersion();

  const [result] = await pipeline.run();

  assert.equal(result?.count, 0);
  assert.equal(schemaVersion(), before);
});
