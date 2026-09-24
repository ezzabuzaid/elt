import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  isCalendarDate,
  isTimestamp,
  MarkdownDestination,
  Pipeline,
  Source,
  type SourceWatchOptions,
  SQLiteCheckpointStore,
  Stream,
  validateRecords,
} from './index.ts';

test('date formats accept only canonical UTC timestamps and real calendar dates', () => {
  assert.equal(isTimestamp('2025-01-02T03:04:05.006Z'), true);
  for (const value of [
    '2025-01-02T03:04:05Z',
    '2025-01-02T03:04:05.006+00:00',
    '2025-02-30T00:00:00.000Z',
    1735787045006,
  ])
    assert.equal(isTimestamp(value), false);
  assert.equal(isCalendarDate('2024-02-29'), true);
  for (const value of ['2025-02-29', '2025-1-02', '2025-01-02T00:00:00.000Z'])
    assert.equal(isCalendarDate(value), false);
});

test('record validation enforces every property of the stream schema', () => {
  const stream = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1 },
        count: { type: 'integer', minimum: 0, maximum: 9 },
        ratio: { type: 'number' },
        kind: { type: 'string', enum: ['a', 'b'] },
        done: { type: 'boolean' },
        at: { type: ['string', 'null'], format: 'date-time' },
        on: { type: 'string', format: 'date' },
      },
    },
    supportedSyncModes: ['full_refresh'],
  });
  const valid = {
    id: 'item-1',
    count: 3,
    ratio: 0.5,
    kind: 'a',
    done: false,
    at: null,
    on: '2024-02-29',
  };

  assert.deepEqual(validateRecords(stream, [valid], 'Test'), [valid]);
  const rejects = (records: unknown, message: string) =>
    assert.throws(() => validateRecords(stream, records, 'Test'), { message });
  rejects({}, 'Test returned invalid items records');
  rejects([null], 'Test returned an invalid items record');
  rejects([{ ...valid, extra: 1 }], 'Test returned an invalid items record');
  const { done: _, ...missing } = valid;
  rejects([missing], 'Test returned an invalid items record');
  for (const [field, value] of [
    ['id', ''],
    ['id', null],
    ['count', 1.5],
    ['count', 2 ** 53],
    ['count', -1],
    ['count', 10],
    ['ratio', Number.NaN],
    ['kind', 'c'],
    ['done', 'false'],
    ['at', '2025-01-02T03:04:05Z'],
    ['on', '2025-02-29'],
  ] as const)
    rejects(
      [{ ...valid, [field]: value }],
      `Test returned invalid items.${field}`,
    );
  const unsupported = new Stream({
    name: 'nested',
    jsonSchema: { type: 'object', properties: { tags: { type: 'array' } } },
    supportedSyncModes: ['full_refresh'],
  });
  assert.throws(
    () => validateRecords(unsupported, [], 'Test'),
    /nested\.tags declares an unsupported type/,
  );
});

test('Markdown file and folder targets honor the deduplication policy', async () => {
  let clicks = 12;
  class RestatingSource extends Source {
    readonly identity = 'markdown-restating-test';
    readonly metrics = new Stream({
      name: 'metrics',
      jsonSchema: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          query: { type: 'string' },
          clicks: { type: 'number' },
        },
      },
      supportedSyncModes: ['full_refresh', 'incremental'],
    });
    protected readonly catalog = new Catalog([this.metrics]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      // The same fact, re-extracted after the upstream restated its metrics.
      yield {
        stream: configuration.stream.name,
        data: { date: '2026-09-20', query: 'elt', clicks },
      };
      yield {
        type: 'STATE' as const,
        stream: configuration.stream.name,
        state: { date: '2026-09-20' },
      };
    }
  }

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-md-'));
  const source = new RestatingSource();
  const destination = new MarkdownDestination({
    path: join(scratch.path, 'markdown'),
  });
  const targets = [
    destination.file('replacing.md'),
    destination.folder('replacing'),
    destination.file('guarding.md'),
    destination.folder('guarding'),
  ];
  const copies = targets.map(
    (target) =>
      new Copy(source.metrics, target, {
        id: target.name,
        syncMode: 'incremental',
        destinationSyncMode: 'append_dedup',
        cursorField: 'date',
        primaryKey: ['query'],
        dedupPolicy: target.name.startsWith('replacing')
          ? 'replace'
          : 'cursor_newer',
      }),
  );
  const pipeline = new Pipeline({
    source,
    destination,
    checkpoints: new SQLiteCheckpointStore({
      path: join(scratch.path, 'state.sqlite'),
    }),
    steps: copies,
  });
  const clicksIn = async (name: string) => {
    const path = join(destination.path, name);
    const files = name.endsWith('.md')
      ? [path]
      : (await readdir(path)).map((file) => join(path, file));
    const documents = await Promise.all(
      files.map((file) => readFile(file, 'utf8')),
    );
    return documents.flatMap((document) =>
      Array.from(
        document.matchAll(/^<!-- mac-elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .clicks,
      ),
    );
  };

  await pipeline.run();
  clicks = 19;
  await pipeline.run();

  assert.deepEqual(
    await Promise.all(targets.map((target) => clicksIn(target.name))),
    [[19], [19], [12], [12]],
  );
});
