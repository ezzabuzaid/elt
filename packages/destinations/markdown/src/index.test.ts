import assert from 'node:assert/strict';
import { mkdtempDisposable, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  type Partition,
  Pipeline,
  PipelineError,
  Source,
  type SourceMessage,
  type SourceWatchOptions,
  Stream,
} from '@workspace/elt';
import { SQLiteCheckpointStore } from '@workspace/elt-sqlite';

import {
  MarkdownDestination,
  type MarkdownFile,
  type MarkdownFolder,
} from './index.ts';

test('Markdown file and folder targets honor the deduplication policy', async () => {
  let clicks = 12;
  class RestatingSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

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
  const checkpoints = new SQLiteCheckpointStore({
    path: join(scratch.path, 'state.sqlite'),
  });
  // A read copies each stream once, so each target of metrics has its own pipeline.
  const run = async () => {
    for (const copy of copies)
      await new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination,
            checkpoints,
            steps: [copy],
          }),
        ],
      }).run();
  };
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
        document.matchAll(/^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .clicks,
      ),
    );
  };

  await run();
  clicks = 19;
  await run();

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
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

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
  } as const;
  // A read copies each stream once, so each target of items has its own pipeline.
  const pipelines = [
    new Copy(items, markdown.file('items.md'), { ...selection, id: 'file' }),
    new Copy(items, markdown.folder('items'), { ...selection, id: 'folder' }),
  ].map(
    (copy) =>
      new Pipeline({
        connections: [
          new Connection({
            name: 'test',
            source,
            destination: markdown,
            checkpoints,
            steps: [copy],
          }),
        ],
      }),
  );
  const names = async () => {
    const decode = (document: string) =>
      Array.from(
        document.matchAll(/^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm),
        ([, encoded]) =>
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .name,
      );
    const folder = join(markdown.path, 'items');
    return [
      decode(await readFile(join(markdown.path, 'items.md'), 'utf8')).sort(),
      (
        await Promise.all(
          (await readdir(folder)).map(async (file) =>
            decode(await readFile(join(folder, file), 'utf8')),
          ),
        )
      )
        .flat()
        .sort(),
    ];
  };
  const runAll = async () => {
    const results = [];
    for (const pipeline of pipelines)
      for (const { count, deleted } of await pipeline.run())
        results.push({ count, deleted });
    return results;
  };

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
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

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
    readonly identity: string;
    readonly owner: string;
    constructor(identity: string, owner: string) {
      super();
      this.identity = identity;
      this.owner = owner;
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
        connections: [
          new Connection({
            name: 'test',
            source,
            destination,
            checkpoints,
            steps: [
              new Copy(source.records, target(), {
                id,
                syncMode: 'incremental',
                destinationSyncMode: 'append_dedup',
                cursorField: 'version',
              }),
            ],
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
        connections: [
          new Connection({
            name: 'test',
            source: late,
            destination,
            steps: [new Copy(late.records, target())],
          }),
        ],
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
          /elt-record/g,
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

test('Markdown publishes at each checkpoint and never publishes a failing partition', async () => {
  class Sites extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'sites';
    readonly down = new Set<string>();
    readonly pages = new Stream({
      name: 'pages',
      jsonSchema: {
        type: 'object',
        properties: { site: { type: 'string' }, views: { type: 'integer' } },
        required: ['site', 'views'],
      },
      primaryKey: ['site'],
      partitionKey: ['site'],
      sourceDefinedCursor: true,
      supportedSyncModes: ['incremental'],
    });
    protected readonly catalog = new Catalog([this.pages]);
    protected override partitions() {
      return [{ site: 'a' }, { site: 'b' }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      _state: unknown,
      partition: Partition | null,
    ) {
      const site = String(partition?.site);
      yield { stream: 'pages', data: { site, views: 1 } };
      if (this.down.has(site)) throw new Error(`${site} is down`);
      yield { type: 'STATE' as const, stream: 'pages', state: { site } };
    }
  }
  const load = async (
    target: (destination: MarkdownDestination) => MarkdownFile | MarkdownFolder,
    published: (path: string) => Promise<number>,
  ) => {
    await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-md-'));
    const source = new Sites();
    source.down.add('b');
    const destination = new MarkdownDestination({ path: scratch.path });
    const error = await new Pipeline({
      connections: [
        new Connection({
          name: 'test',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(source.pages, target(destination), {
              id: 'pages',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
          ],
        }),
      ],
    })
      .run()
      .then(
        () => assert.fail('run should report the failed partition'),
        (error: unknown) => error,
      );
    assert.ok(error instanceof PipelineError, String(error));
    assert.match(error.message, /\{"site":"b"\}: b is down/);
    assert.equal(await published(scratch.path), 1);
  };

  await load(
    (destination) => destination.file('pages.md'),
    async (path) =>
      (await readFile(join(path, 'pages.md'), 'utf8')).match(/elt-record/g)
        ?.length ?? 0,
  );
  await load(
    (destination) => destination.folder('pages'),
    async (path) =>
      (await readdir(join(path, 'pages'))).filter((name) =>
        name.endsWith('.md'),
      ).length,
  );
});

test('clearing a Markdown target drops it with its checkpoint, and a deleted one reloads from no checkpoint', async () => {
  class Pages extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'pages';
    readonly pages = new Stream({
      name: 'pages',
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      primaryKey: ['id'],
      sourceDefinedCursor: true,
      supportedSyncModes: ['incremental'],
    });
    protected readonly catalog = new Catalog([this.pages]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      state: unknown,
    ) {
      if (state === null) yield { stream: 'pages', data: { id: 'first' } };
      yield { type: 'STATE' as const, stream: 'pages', state: { seen: true } };
    }
  }
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-md-'));
  const source = new Pages();
  const destination = new MarkdownDestination({ path: scratch.path });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.pages, destination.file('pages.md'), {
            id: 'pages',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  const records = async () =>
    (await readFile(join(scratch.path, 'pages.md'), 'utf8')).match(
      /elt-record/g,
    )?.length ?? 0;
  await pipeline.run();

  await rm(join(scratch.path, 'pages.md'));
  await pipeline.run();
  assert.equal(await records(), 1);
  await pipeline.clear();
  await pipeline.run();

  assert.equal(await records(), 1);
});

test('one run loads a file and a folder together: a stream that fails keeps its published target and checkpoint while its sibling commits, and a rerun converges', async () => {
  const keyed = (name: string) =>
    new Stream({
      name,
      jsonSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      primaryKey: ['id'],
      sourceDefinedCursor: true,
      supportedSyncModes: ['incremental'],
    });
  // tasks stages a record, notes commits, and only then does tasks fail. Each
  // gate opens when the consumer asks for a stream's next message, so the
  // order holds without timers.
  class Crossing extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    readonly identity = 'crossing';
    readonly notes = keyed('notes');
    readonly tasks = keyed('tasks');
    protected readonly catalog = new Catalog([this.notes, this.tasks]);
    protected override readonly concurrency = 2;
    batch = 0;
    failing = false;
    readonly resumed: string[] = [];
    #staged = Promise.withResolvers<void>();
    #committed = Promise.withResolvers<void>();

    protected override async open() {
      this.#staged = Promise.withResolvers<void>();
      this.#committed = Promise.withResolvers<void>();
      return new AsyncDisposableStack();
    }

    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }

    protected override async *extract(
      configuration: CopyConfiguration,
      state: unknown,
    ) {
      const name = configuration.stream.name;
      this.resumed.push(`${name} from ${JSON.stringify(state)}`);
      if (name === 'notes') {
        await this.#staged.promise;
        yield { stream: name, data: { id: `n${this.batch}` } };
        yield { type: 'STATE' as const, stream: name, state: this.batch };
        this.#committed.resolve();
        return;
      }
      yield { stream: name, data: { id: `t${this.batch}` } };
      this.#staged.resolve();
      if (this.failing) {
        await this.#committed.promise;
        throw new Error('tasks upstream');
      }
      yield { type: 'STATE' as const, stream: name, state: this.batch };
    }
  }
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-md-'));
  const source = new Crossing();
  const destination = new MarkdownDestination({ path: scratch.path });
  const selection = (id: string) =>
    ({
      id,
      syncMode: 'incremental',
      destinationSyncMode: 'append_dedup',
    }) as const;
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(
            source.notes,
            destination.file('notes.md'),
            selection('notes'),
          ),
          new Copy(
            source.tasks,
            destination.folder('tasks'),
            selection('tasks'),
          ),
        ],
      }),
    ],
  });
  const ids = (document: string) =>
    Array.from(
      document.matchAll(/^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm),
      ([, encoded]) =>
        String(
          JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8'))
            .id,
        ),
    );
  const published = async () => {
    const folder = join(scratch.path, 'tasks');
    const documents = await Promise.all(
      (await readdir(folder)).map((file) =>
        readFile(join(folder, file), 'utf8'),
      ),
    );
    return {
      notes: ids(await readFile(join(scratch.path, 'notes.md'), 'utf8')).sort(),
      tasks: documents.flatMap(ids).sort(),
    };
  };
  source.batch = 1;
  await pipeline.run();
  source.batch = 2;
  source.failing = true;

  const error = await pipeline.run().then(
    () => assert.fail('tasks should fail the run'),
    (error: unknown) => error,
  );
  const afterFailure = await published();
  source.failing = false;
  source.resumed.length = 0;
  await pipeline.run();

  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.map(({ copy, count, failures }) => [
      copy.from.name,
      count,
      failures.length,
    ]),
    [
      ['notes', 1, 0],
      ['tasks', 0, 1],
    ],
  );
  assert.deepEqual(afterFailure, { notes: ['n1', 'n2'], tasks: ['t1'] });
  // The rerun resumes notes from its new checkpoint and tasks from its old one.
  assert.deepEqual(source.resumed.sort(), ['notes from 2', 'tasks from 1']);
  assert.deepEqual(await published(), {
    notes: ['n1', 'n2'],
    tasks: ['t1', 't2'],
  });
});

test('int64 cursors keep the greater integer, and int64 and base64 keys delete their rows', async () => {
  let messages: SourceMessage[] = [];
  const rows = new Stream({
    name: 'rows',
    jsonSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', format: 'int64' },
        hash: { type: 'string', contentEncoding: 'base64' },
        version: { type: 'string', format: 'int64' },
        name: { type: 'string' },
      },
    },
    primaryKey: ['id', 'hash'],
    supportedSyncModes: ['incremental'],
    emitsDeletes: true,
  });
  class LedgerSource extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'int64-test';
    protected readonly catalog = new Catalog([rows]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
      yield { type: 'STATE' as const, stream: 'rows', state: {} };
    }
  }
  const row = (id: string, hash: string, version: string, name: string) => ({
    stream: 'rows',
    data: { id, hash, version, name },
  });

  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-int64-'));
  const markdown = new MarkdownDestination({ path: join(scratch.path, 'md') });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new LedgerSource(),
        destination: markdown,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(rows, markdown.file('rows.md'), {
            id: 'rows',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
            cursorField: 'version',
          }),
        ],
      }),
    ],
  });
  const loaded = async () =>
    Array.from(
      (await readFile(join(markdown.path, 'rows.md'), 'utf8')).matchAll(
        /^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm,
      ),
      ([, encoded]) => {
        const { id, version, name } = JSON.parse(
          Buffer.from(String(encoded), 'base64').toString('utf8'),
        );
        return `${id} ${version} ${name}`;
      },
    ).sort();

  // As text "9" sorts after "10"; as numbers both versions of the second row
  // round to 9007199254740992 and tie.
  messages = [
    row('1', 'AA==', '9', 'old'),
    row('1', 'AA==', '10', 'new'),
    row('9007199254740993', '/w==', '9007199254740992', 'old'),
    row('9007199254740993', '/w==', '9007199254740993', 'new'),
  ];
  await pipeline.run();
  assert.deepEqual(await loaded(), [
    '1 10 new',
    '9007199254740993 9007199254740993 new',
  ]);

  messages = [
    {
      type: 'DELETE',
      stream: 'rows',
      key: { id: '9007199254740993', hash: '/w==' },
    },
  ];
  await pipeline.run();
  assert.deepEqual(await loaded(), ['1 10 new']);
});

test('a reset replaces only its partition at the next commit, and one a failure dropped never reaches a later commit', async () => {
  const items = new Stream({
    name: 'items',
    jsonSchema: {
      type: 'object',
      properties: { account: { type: 'string' }, id: { type: 'string' } },
    },
    primaryKey: ['account', 'id'],
    partitionKey: ['account'],
    supportedSyncModes: ['incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  // What each partition emits on the next run.
  let script: Record<string, (SourceMessage | Error)[]> = {};
  class Resetting extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'resetting';
    protected readonly catalog = new Catalog([items]);
    protected override partitions() {
      return [{ account: 'a' }, { account: 'b' }];
    }
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract(
      _configuration: CopyConfiguration,
      _state: unknown,
      partition: Partition | null,
    ) {
      for (const message of script[String(partition?.account)] ?? []) {
        if (message instanceof Error) throw message;
        yield message;
      }
    }
  }
  const record = (account: string, id: string) => ({
    stream: 'items',
    data: { account, id },
  });
  const reset = { type: 'RESET' as const, stream: 'items' };
  const state = { type: 'STATE' as const, stream: 'items', state: {} };
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-reset-'));
  const destination = new MarkdownDestination({
    path: join(scratch.path, 'md'),
  });
  const into = destination.file('items.md');
  const loaded = async () =>
    Array.from(
      (await readFile(join(destination.path, 'items.md'), 'utf8')).matchAll(
        /^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm,
      ),
      ([, encoded]) => {
        const { account, id } = JSON.parse(
          Buffer.from(String(encoded), 'base64').toString('utf8'),
        );
        return `${account}${id}`;
      },
    ).sort();
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Resetting(),
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(items, into, {
            id: 'items',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });

  script = {
    a: [record('a', '1'), record('a', '2'), state],
    b: [record('b', '1'), state],
  };
  await pipeline.run();
  script = { a: [reset, record('a', '2'), state], b: [state] };
  await pipeline.run();
  assert.deepEqual(await loaded(), ['a2', 'b1']);

  script = {
    a: [reset, record('a', '3'), new Error('gone')],
    b: [record('b', '2'), state],
  };
  await assert.rejects(pipeline.run(), PipelineError);
  assert.deepEqual(await loaded(), ['a2', 'b1', 'b2']);
});

test('a full refresh ignores resets, so an appending copy keeps its history', async () => {
  let messages: SourceMessage[] = [];
  const items = new Stream({
    name: 'items',
    jsonSchema: { type: 'object', properties: { id: { type: 'string' } } },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
  });
  class Resetting extends Source {
    override coverage() {
      return { description: 'test', selection: {} };
    }

    protected override async open() {
      return new AsyncDisposableStack();
    }

    readonly identity = 'resetting';
    protected readonly catalog = new Catalog([items]);
    protected override async *observe({ streams }: SourceWatchOptions) {
      yield streams;
    }
    protected override async *extract() {
      yield* messages;
    }
  }
  await using scratch = await mkdtempDisposable(join(tmpdir(), 'elt-reset-'));
  const destination = new MarkdownDestination({
    path: join(scratch.path, 'md'),
  });
  const pipeline = new Pipeline({
    connections: [
      new Connection({
        name: 'test',
        source: new Resetting(),
        destination,
        steps: [
          new Copy(items, destination.file('items.md'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'append',
          }),
        ],
      }),
    ],
  });
  const ids = async () =>
    Array.from(
      (await readFile(join(destination.path, 'items.md'), 'utf8')).matchAll(
        /^<!-- elt-record:([A-Za-z0-9+/=]+) -->$/gm,
      ),
      ([, encoded]) =>
        JSON.parse(Buffer.from(String(encoded), 'base64').toString('utf8')).id,
    );

  messages = [{ stream: 'items', data: { id: '1' } }];
  await pipeline.run();
  messages = [
    { type: 'RESET', stream: 'items' },
    { stream: 'items', data: { id: '2' } },
  ];
  await pipeline.run();

  assert.deepEqual(await ids(), ['1', '2']);
});
