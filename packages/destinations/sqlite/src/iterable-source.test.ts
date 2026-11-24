import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';

import {
  Connection,
  Copy,
  Gauge,
  IterableSource,
  Pipeline,
  PipelineError,
} from '@eltjs/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

type Task = { name: string; text: string };

const tasksSchema = {
  type: 'object',
  description: 'A task.',
  properties: {
    name: { type: 'string', description: 'Name of the task.' },
    text: { type: 'string', description: 'What the task asks.' },
  },
  required: ['name', 'text'],
} as const;

// The rows of a table, with the commit that wrote each one.
function loaded(path: string, table = 'tasks') {
  using database = open(path, { readOnly: true });
  return database
    .prepare(`SELECT name, text, committed_in FROM raw_${table} ORDER BY name`)
    .all()
    .map(({ name, text, committed_in }) => ({ name, text, committed_in }));
}

// The rows of a table without their commits.
const contentOf = (path: string, table = 'tasks') =>
  loaded(path, table).map(({ name, text }) => ({ name, text }));

const modes = [
  { syncMode: 'full_refresh', destinationSyncMode: 'overwrite_dedup' },
  { syncMode: 'incremental', destinationSyncMode: 'append_dedup' },
] as const;

for (const mode of modes)
  test(`a key that the host gives twice in one push fails the read of a ${mode.syncMode} copy, and the target keeps the rows of the pass before`, async () => {
    let rows: Task[] = [{ name: 'a', text: 'first a' }];
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          snapshot: () => rows,
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              id: 'tasks',
              ...mode,
            }),
          ],
        }),
      ],
    });
    await pipeline.run();

    rows = [
      { name: 'a', text: 'second a' },
      { name: 'b', text: 'b' },
      { name: 'a', text: 'third a' },
    ];
    const error = await pipeline.run().then(
      () => assert.fail('a repeated key should fail the read'),
      (error: unknown) => error,
    );

    assert.ok(error instanceof PipelineError, String(error));
    assert.deepEqual(
      error.results.flatMap(({ failures }) =>
        failures.map(({ error }) =>
          Error.isError(error) ? error.message : String(error),
        ),
      ),
      ['Snapshot tasks returned name a twice in one scan'],
    );
    assert.deepEqual(contentOf(destination.path), [
      { name: 'a', text: 'first a' },
    ]);
  });

for (const mode of modes) {
  test(`a host whose rows throw halfway fails the ${mode.syncMode} stream, and the target keeps every row of the pass before`, async () => {
    let failing = false;
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          deletions: 'closed-world',
          *snapshot() {
            if (!failing) {
              yield* [
                { name: 'a', text: 'a' },
                { name: 'b', text: 'b' },
                { name: 'c', text: 'c' },
              ];
              return;
            }
            yield { name: 'a', text: 'a changed' };
            throw new Error('host read failed halfway');
          },
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              id: 'tasks',
              ...mode,
            }),
          ],
        }),
      ],
    });
    await pipeline.run();
    const before = loaded(destination.path);

    failing = true;
    await assert.rejects(pipeline.run(), /host read failed halfway/);

    using database = open(destination.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT stream, status FROM stream_status')
        .all()
        .map(({ stream, status }) => ({ stream, status })),
      [{ stream: 'tasks', status: 'failed' }],
    );
    assert.deepEqual(loaded(destination.path), before);
  });

  test(
    `an abort halfway cancels the ${mode.syncMode} stream, stops the host's rows through the run's signal, and the target keeps every row of the pass before`,
    { timeout: 30_000 },
    async () => {
      let aborting = false;
      const controller = new AbortController();
      const source = new IterableSource({
        identity: 'tasks',
        streams: {
          tasks: {
            description: 'The tasks that the test gives.',
            jsonSchema: tasksSchema,
            primaryKey: ['name'],
            deletions: 'closed-world',
            async *snapshot({ signal }) {
              if (!aborting) {
                yield* [
                  { name: 'a', text: 'a' },
                  { name: 'b', text: 'b' },
                  { name: 'c', text: 'c' },
                ];
                return;
              }
              yield { name: 'a', text: 'a changed' };
              controller.abort(new Error('stop halfway'));
              // The host waits for more rows until the run stops it.
              await new Promise((_, reject) => {
                signal.throwIfAborted();
                signal.addEventListener('abort', () => reject(signal.reason));
              });
            },
          },
        },
      });
      await using scratch = await new TemporaryFiles().directory(
        'elt-iterable-',
      );
      const destination = new SQLiteDestination({
        path: join(scratch.path, 'd.sqlite'),
      });
      const pipeline = new Pipeline({
        clock: globalThis,
        history: new SQLiteSyncHistory(),
        connections: [
          new Connection({
            name: 'tasks',
            source,
            destination,
            checkpoints: new SQLiteCheckpointStore({
              path: join(scratch.path, 'state.sqlite'),
            }),
            steps: [
              new Copy(source.streams.tasks, destination.table('tasks'), {
                id: 'tasks',
                ...mode,
              }),
            ],
          }),
        ],
      });
      await pipeline.run();
      const before = loaded(destination.path);

      aborting = true;
      await assert.rejects(
        pipeline.run({ signal: controller.signal }),
        /stop halfway/,
      );

      using database = open(destination.path, { readOnly: true });
      assert.deepEqual(
        database
          .prepare('SELECT stream, status FROM stream_status')
          .all()
          .map(({ stream, status }) => ({ stream, status })),
        [{ stream: 'tasks', status: 'cancelled' }],
      );
      assert.deepEqual(loaded(destination.path), before);
    },
  );
}

for (const mode of modes)
  test(`a ${mode.syncMode} scan that ends after an abort is no complete scan: the stream is cancelled and the target keeps every row of the pass before`, async () => {
    let aborting = false;
    const controller = new AbortController();
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          deletions: 'closed-world',
          *snapshot() {
            if (!aborting) {
              yield* [
                { name: 'a', text: 'a' },
                { name: 'b', text: 'b' },
                { name: 'c', text: 'c' },
              ];
              return;
            }
            // A host that does not read the signal: it stops giving rows
            // once the run is stopped, as if it held no more.
            yield { name: 'a', text: 'a changed' };
            controller.abort(new Error('stop halfway'));
          },
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              id: 'tasks',
              ...mode,
            }),
          ],
        }),
      ],
    });
    await pipeline.run();
    const before = loaded(destination.path);

    aborting = true;
    await assert.rejects(
      pipeline.run({ signal: controller.signal }),
      /stop halfway/,
    );

    using database = open(destination.path, { readOnly: true });
    assert.deepEqual(
      database
        .prepare('SELECT stream, status FROM stream_status')
        .all()
        .map(({ stream, status }) => ({ stream, status })),
      [{ stream: 'tasks', status: 'cancelled' }],
    );
    assert.deepEqual(loaded(destination.path), before);
  });

for (const mode of modes)
  test(`a ${mode.syncMode} copy of rows that did not change writes no row`, async () => {
    const rows: Task[] = [
      { name: 'a', text: 'a' },
      { name: 'b', text: 'b' },
    ];
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          deletions: 'closed-world',
          snapshot: () => rows,
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              id: 'tasks',
              ...mode,
            }),
          ],
        }),
      ],
    });
    await pipeline.run();
    const before = loaded(destination.path);

    await pipeline.run();

    assert.equal(before.length, 2);
    assert.deepEqual(loaded(destination.path), before);
  });

for (const mode of modes)
  test(`a ${mode.syncMode} copy of a closed-world stream deletes the row that the host stops giving`, async () => {
    let rows: Task[] = [
      { name: 'a', text: 'a' },
      { name: 'b', text: 'b' },
    ];
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          deletions: 'closed-world',
          snapshot: () => rows,
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          checkpoints: new SQLiteCheckpointStore({
            path: join(scratch.path, 'state.sqlite'),
          }),
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              id: 'tasks',
              ...mode,
            }),
          ],
        }),
      ],
    });
    await pipeline.run();

    rows = [{ name: 'b', text: 'b' }];
    await pipeline.run();

    assert.deepEqual(contentOf(destination.path), [{ name: 'b', text: 'b' }]);
  });

test('an incremental copy of a stream that declares no deletions keeps the row that the host stops giving', async () => {
  let rows: Task[] = [
    { name: 'a', text: 'a' },
    { name: 'b', text: 'b' },
  ];
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        snapshot: () => rows,
      },
    },
  });
  await using scratch = await new TemporaryFiles().directory('elt-iterable-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            id: 'tasks',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  await pipeline.run();

  rows = [{ name: 'b', text: 'b' }];
  await pipeline.run();

  assert.deepEqual(contentOf(destination.path), [
    { name: 'a', text: 'a' },
    { name: 'b', text: 'b' },
  ]);
});

test('an incremental copy compares the rowVersion in place of the content: a row whose version did not change is not read again although its content changed, and a row whose version changed is', async () => {
  type Versioned = Task & { version: number };
  let rows: Versioned[] = [
    { name: 'a', text: 'a', version: 1 },
    { name: 'b', text: 'b', version: 1 },
  ];
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: {
          type: 'object',
          description: 'A task.',
          properties: {
            name: { type: 'string', description: 'Name of the task.' },
            text: { type: 'string', description: 'What the task asks.' },
            version: {
              type: 'integer',
              description: 'Raised at each change of the task.',
            },
          },
          required: ['name', 'text', 'version'],
        },
        primaryKey: ['name'],
        rowVersion: 'version',
        snapshot: () => rows,
      },
    },
  });
  await using scratch = await new TemporaryFiles().directory('elt-iterable-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(scratch.path, 'state.sqlite'),
        }),
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            id: 'tasks',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
  await pipeline.run();

  // The host changes a's text but forgets its version, and changes b with
  // its version: the documented hazard of a version that misses a change.
  rows = [
    { name: 'a', text: 'a changed', version: 1 },
    { name: 'b', text: 'b changed', version: 2 },
  ];
  await pipeline.run();

  assert.deepEqual(contentOf(destination.path), [
    { name: 'a', text: 'a' },
    { name: 'b', text: 'b changed' },
  ]);
});

test(
  'changed() tells a watch that the host’s rows changed, and the watch loads them',
  { timeout: 30_000 },
  async (t) => {
    let rows: Task[] = [{ name: 'a', text: 'a' }];
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          snapshot: () => rows,
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite_dedup',
            }),
          ],
        }),
      ],
    });
    const controller = new AbortController();
    const passes = (async () => {
      for await (const _ of pipeline.watch({ signal: controller.signal }));
    })();
    try {
      await waitFor(
        () => {
          assert.deepEqual(contentOf(destination.path), rows);
        },
        { signal: t.signal },
      );
      rows = [
        { name: 'a', text: 'a' },
        { name: 'b', text: 'b' },
      ];

      source.changed(source.streams.tasks);

      await waitFor(
        () => {
          assert.deepEqual(contentOf(destination.path), rows);
        },
        { signal: t.signal },
      );
    } finally {
      controller.abort();
      await passes;
    }
  },
);

test(
  'a change signal of the host tells a watch that the host’s rows changed',
  { timeout: 30_000 },
  async (t) => {
    let rows: Task[] = [{ name: 'a', text: 'a' }];
    let version = 0;
    // The host's own store, which counts its changes.
    class Version extends Gauge<number> {
      protected async read() {
        return version;
      }
    }
    const source = new IterableSource({
      identity: 'tasks',
      streams: {
        tasks: {
          description: 'The tasks that the test gives.',
          jsonSchema: tasksSchema,
          primaryKey: ['name'],
          snapshot: () => rows,
          changeSignal: {
            gauge: () => new Version(),
            interval: 50,
            timeout: 1000,
          },
        },
      },
    });
    await using scratch = await new TemporaryFiles().directory('elt-iterable-');
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'd.sqlite'),
    });
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'tasks',
          source,
          destination,
          steps: [
            new Copy(source.streams.tasks, destination.table('tasks'), {
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite_dedup',
            }),
          ],
        }),
      ],
    });
    const controller = new AbortController();
    const passes = (async () => {
      for await (const _ of pipeline.watch({ signal: controller.signal }));
    })();
    try {
      await waitFor(
        () => {
          assert.deepEqual(contentOf(destination.path), rows);
        },
        { signal: t.signal },
      );

      rows = [
        { name: 'a', text: 'a' },
        { name: 'b', text: 'b' },
      ];
      version += 1;

      await waitFor(
        () => {
          assert.deepEqual(contentOf(destination.path), rows);
        },
        { signal: t.signal },
      );
    } finally {
      controller.abort();
      await passes;
    }
  },
);

test('each pass records the description of the stream as its coverage', async () => {
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        snapshot: () => [{ name: 'a', text: 'a' }],
      },
    },
  });
  await using scratch = await new TemporaryFiles().directory('elt-iterable-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
  });

  await pipeline.run();

  using database = open(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare('SELECT stream, description, selection FROM extraction_coverage')
      .all()
      .map(({ stream, description, selection }) => ({
        stream,
        description,
        selection,
      })),
    [
      {
        stream: 'tasks',
        description: 'The tasks that the test gives.',
        selection: '{}',
      },
    ],
  );
});

test('a stream whose host cannot tell how current its rows are is not read, and fails with the host’s error', async () => {
  let read = false;
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        currentAsOf: () => Promise.reject(new Error('the store is gone')),
        *snapshot() {
          read = true;
          yield { name: 'a', text: 'a' };
        },
      },
    },
  });
  await using scratch = await new TemporaryFiles().directory('elt-iterable-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
  });

  await assert.rejects(pipeline.run(), /the store is gone/);

  assert.equal(read, false);
});

test('an error of a class in configErrors fails the copy as config, and another error as system', async () => {
  class HostAccessError extends Error {}
  let failure: Error = new HostAccessError('no access to the host store');
  const source = new IterableSource({
    identity: 'tasks',
    configErrors: [HostAccessError],
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        snapshot: (): Task[] => {
          throw failure;
        },
      },
    },
  });
  await using scratch = await new TemporaryFiles().directory('elt-iterable-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
  });
  const failureTypes = () =>
    pipeline.run().then(
      () => assert.fail('the host error should fail the copy'),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError, String(error));
        return error.results.flatMap(({ failures }) =>
          failures.map(({ failureType }) => failureType),
        );
      },
    );

  const asConfig = await failureTypes();
  failure = new Error('the host broke');
  const asSystem = await failureTypes();

  assert.deepEqual([asConfig, asSystem], [['config'], ['system']]);
});

test('the stream that a declaration builds supports both sync modes, defines its own cursor, and emits deletions only in a closed world', () => {
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      closed: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        deletions: 'closed-world',
        snapshot: () => [],
      },
      open: {
        description: 'The tasks that the test gives.',
        jsonSchema: tasksSchema,
        primaryKey: ['name'],
        snapshot: () => [],
      },
    },
  });

  assert.deepEqual(
    [source.streams.closed, source.streams.open].map(
      ({
        name,
        primaryKey,
        supportedSyncModes,
        sourceDefinedCursor,
        emitsDeletes,
      }) => ({
        name,
        primaryKey,
        supportedSyncModes,
        sourceDefinedCursor,
        emitsDeletes,
      }),
    ),
    [
      {
        name: 'closed',
        primaryKey: ['name'],
        supportedSyncModes: ['full_refresh', 'incremental'],
        sourceDefinedCursor: true,
        emitsDeletes: true,
      },
      {
        name: 'open',
        primaryKey: ['name'],
        supportedSyncModes: ['full_refresh', 'incremental'],
        sourceDefinedCursor: true,
        emitsDeletes: undefined,
      },
    ],
  );
});

test('a key of two fields keeps one row for each pair, and a full refresh fails at a pair that the host gives twice', async () => {
  type Placed = { list: string; name: string; text: string };
  let rows: Placed[] = [
    { list: 'home', name: 'a', text: 'home a' },
    { list: 'home', name: 'b', text: 'home b' },
    { list: 'work', name: 'a', text: 'work a' },
  ];
  const source = new IterableSource({
    identity: 'tasks',
    streams: {
      tasks: {
        description: 'The tasks that the test gives.',
        jsonSchema: {
          type: 'object',
          description: 'A task in a list.',
          properties: {
            list: { type: 'string', description: 'The list of the task.' },
            name: { type: 'string', description: 'Name of the task.' },
            text: { type: 'string', description: 'What the task asks.' },
          },
          required: ['list', 'name', 'text'],
        },
        primaryKey: ['list', 'name'],
        snapshot: () => rows,
      },
    },
  });
  await using scratch = await new TemporaryFiles().directory('elt-iterable-');
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'd.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'tasks',
        source,
        destination,
        steps: [
          new Copy(source.streams.tasks, destination.table('tasks'), {
            syncMode: 'full_refresh',
            destinationSyncMode: 'overwrite_dedup',
          }),
        ],
      }),
    ],
  });
  const tasks = () => {
    using database = open(destination.path, { readOnly: true });
    return database
      .prepare('SELECT list, name, text FROM tasks ORDER BY list, name')
      .all()
      .map(({ list, name, text }) => ({ list, name, text }));
  };
  await pipeline.run();
  const first = tasks();

  rows = [...rows, { list: 'home', name: 'a', text: 'home a again' }];
  const error = await pipeline.run().then(
    () => assert.fail('a repeated pair should fail the read'),
    (error: unknown) => error,
  );

  assert.deepEqual(first, [
    { list: 'home', name: 'a', text: 'home a' },
    { list: 'home', name: 'b', text: 'home b' },
    { list: 'work', name: 'a', text: 'work a' },
  ]);
  assert.ok(error instanceof PipelineError, String(error));
  assert.deepEqual(
    error.results.flatMap(({ failures }) =>
      failures.map(({ error }) =>
        Error.isError(error) ? error.message : String(error),
      ),
    ),
    ['Snapshot tasks returned list home, name a twice in one scan'],
  );
});

test('the constructor refuses a rowVersion that the jsonSchema does not declare', () => {
  assert.throws(
    () =>
      new IterableSource({
        identity: 'tasks',
        streams: {
          tasks: {
            description: 'The tasks that the test gives.',
            jsonSchema: tasksSchema,
            primaryKey: ['name'],
            // @ts-expect-error -- the schema declares no version
            rowVersion: 'version',
            snapshot: () => [],
          },
        },
      }),
    {
      name: 'TypeError',
      message:
        'Stream tasks names rowVersion version, which its jsonSchema does not declare',
    },
  );
});

test('the constructor refuses a stream with no primaryKey', () => {
  assert.throws(
    () =>
      new IterableSource({
        identity: 'tasks',
        streams: {
          tasks: {
            description: 'The tasks that the test gives.',
            jsonSchema: tasksSchema,
            // @ts-expect-error -- a key has one field or more
            primaryKey: [],
            snapshot: () => [],
          },
        },
      }),
    {
      name: 'TypeError',
      message: 'Stream tasks of an IterableSource needs a primaryKey',
    },
  );
});
