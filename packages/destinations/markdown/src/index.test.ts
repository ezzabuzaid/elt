import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  Catalog,
  Copy,
  type CopyConfiguration,
  Pipeline,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from 'elt';
import { SQLiteCheckpointStore } from 'elt-sqlite';
import {
  MarkdownDestination,
  type MarkdownFile,
  type MarkdownFolder,
} from './index.ts';

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

test('deletions remove keyed records from deduplicating Markdown files and folders', async () => {
  let messages: SourceMessage[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class DeletingSource extends Source {
    readonly identity = 'deleting-test';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
      yield { type: 'STATE' as const, stream: 'items', state: {} };
    }
  }
  const record = (id: string, name: string) => ({
    stream: 'items',
    data: { id, name },
  });
  const remove = (id: string) => ({
    type: 'DELETE' as const,
    stream: 'items',
    key: { id },
  });

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-delete-'));
  const source = new DeletingSource();
  const markdown = new MarkdownDestination({ path: join(scratch.path, 'md') });
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  const selection = {
    syncMode: 'incremental',
    destinationSyncMode: 'append_dedup',
    primaryKey: ['id'],
  } as const;
  const pipeline = new Pipeline({
    source,
    destination: markdown,
    checkpoints,
    steps: [
      new Copy(items, markdown.file('items.md'), { ...selection, id: 'file' }),
      new Copy(items, markdown.folder('items'), {
        ...selection,
        id: 'folder',
      }),
    ],
  });
  const names = async () => {
    const decode = (document: string) =>
      Array.from(
        document.matchAll(/^<!-- mac-elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .name,
      );
    const folder = join(markdown.path, 'items');
    return [
      decode(await readFile(join(markdown.path, 'items.md'), 'utf8')).sort(),
      (
        await Promise.all(
          (
            await readdir(folder)
          ).map(async (file) =>
            decode(await readFile(join(folder, file), 'utf8')),
          ),
        )
      )
        .flat()
        .sort(),
    ];
  };
  const runAll = async () =>
    (await pipeline.run()).map(({ count, deleted }) => ({ count, deleted }));

  messages = [record('a', 'A'), record('b', 'B'), record('c', 'C')];
  await runAll();
  // Operations apply in source order: b is deleted, re-added, then deleted again.
  messages = [
    remove('b'),
    record('b', 'B2'),
    remove('b'),
    remove('c'),
    record('a', 'A2'),
  ];
  assert.deepEqual(await runAll(), Array(2).fill({ count: 2, deleted: 3 }));
  assert.deepEqual(await names(), Array(2).fill(['A2']));
  // At-least-once replay of the same operations leaves every target unchanged.
  assert.deepEqual(await runAll(), Array(2).fill({ count: 2, deleted: 3 }));
  assert.deepEqual(await names(), Array(2).fill(['A2']));
});

test('a target has one writer, even when another loads only its own partitions', async () => {
  class Records extends Source {
    extracted = 0;
    readonly records = new Stream({
      name: 'records',
      jsonSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string' },
          id: { type: 'string' },
          name: { type: 'string' },
          version: { type: 'integer' },
        },
        required: ['owner', 'id', 'name', 'version'],
      },
      primaryKey: ['owner', 'id'],
      supportedSyncModes: ['full_refresh', 'incremental'],
      partitionKey: ['owner'],
    });
    protected readonly catalog = new Catalog([this.records]);
    constructor(
      readonly identity: string,
      readonly owner: string,
    ) {
      super();
    }
    protected override partitions() {
      return [{ owner: this.owner }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(configuration: CopyConfiguration) {
      this.extracted++;
      yield {
        stream: configuration.stream.name,
        data: { owner: this.owner, id: '1', name: this.identity, version: 1 },
      };
    }
  }
  const scenario = async (
    destination: MarkdownDestination,
    target: () => MarkdownFile | MarkdownFolder,
    checkpoints: SQLiteCheckpointStore,
    loaded: () => Promise<number>,
  ) => {
    const upsert = (id: string, source: Records) =>
      new Pipeline({
        source,
        destination,
        checkpoints,
        steps: [
          new Copy(source.records, target(), {
            id,
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
            primaryKey: ['owner', 'id'],
          }),
        ],
      }).run();
    const other = new Records('b', 'b');
    const late = new Records('late', 'c');

    await upsert('a', new Records('a', 'a'));
    await upsert('a', new Records('a', 'a'));
    await assert.rejects(
      upsert('b', other),
      /is written by \{"copy":"a"\}; \{"copy":"b"\} cannot write it/,
    );
    await assert.rejects(
      new Pipeline({
        source: late,
        destination,
        steps: [new Copy(late.records, target())],
      }).run(),
      /\{"source":"late","stream":"records"\} cannot write it/,
    );

    assert.equal(other.extracted + late.extracted, 0);
    assert.equal(await loaded(), 1);
  };

  {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-own-'));
    const destination = new MarkdownDestination({ path: scratch.path });
    await scenario(
      destination,
      () => destination.file('records.md'),
      new SQLiteCheckpointStore({ path: join(scratch.path, 'state.sqlite') }),
      async () =>
        (await readFile(join(scratch.path, 'records.md'), 'utf8')).match(
          /mac-elt-record/g,
        )?.length ?? 0,
    );
  }
  {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-own-'));
    const destination = new MarkdownDestination({ path: scratch.path });
    await scenario(
      destination,
      () => destination.folder('records'),
      new SQLiteCheckpointStore({ path: join(scratch.path, 'state.sqlite') }),
      async () =>
        (await readdir(join(scratch.path, 'records'))).filter((name) =>
          name.endsWith('.md'),
        ).length,
    );
  }
});
