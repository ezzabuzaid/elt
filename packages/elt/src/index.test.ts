import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  SQLiteDestination,
  Stream,
} from './index.ts';

test('the public ELT API copies source records into SQLite', async () => {
  class TestSource extends Source {
    readonly identity = 'test';
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });

    async discover() {
      return new Catalog([this.records]);
    }

    validate(configuration: CopyConfiguration) {
      configuration.validate(this.records);
    }

    protected override async *extract(configuration: CopyConfiguration) {
      yield {
        stream: configuration.stream.name,
        data: { id: 'record-1', name: 'Test record' },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-test-'));
  const source = new TestSource();
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'records.sqlite'),
  });
  const copy = new Copy(source.records, destination.table('records'));
  const results = await new Pipeline({
    source,
    destination,
    steps: [copy],
  }).run();

  assert.deepEqual(results, [{ copy, count: 1 }]);
  using database = new DatabaseSync(destination.path, { readOnly: true });
  const row = database.prepare('SELECT id, name FROM records').get();
  assert.ok(row);
  assert.deepEqual({ ...row }, { id: 'record-1', name: 'Test record' });
});
