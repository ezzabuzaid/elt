import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { ClosedWorld } from '@zukhruf/snapshot-differential';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  LocalFiles,
  Pipeline,
  Source,
  type SourceWatchOptions,
  Stream,
  diffSnapshot,
} from '@workspace/elt';

import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

// An app's store whose every scan lists all its notes, as Apple's stores do,
// each with the file the app keeps it in.
class Notes extends Source {
  readonly identity = 'notes';
  readonly received: unknown[] = [];
  readonly list = [
    { id: 'a', title: 'Groceries' },
    { id: 'b', title: 'Trip' },
  ];
  readonly attachments = new Map<string, string>();
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' } },
      required: ['id', 'title'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh', 'incremental'],
    sourceDefinedCursor: true,
    emitsDeletes: true,
    supportsFileTransfer: true,
  });
  protected readonly catalog = new Catalog([this.notes]);

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

  protected override async *extract(
    configuration: CopyConfiguration,
    state: unknown,
  ) {
    this.received.push(state);
    for await (const message of diffSnapshot(configuration, this.list, state, {
      policy: new ClosedWorld(),
      signal: undefined,
    }))
      yield 'type' in message || configuration.fileReads.length === 0
        ? message
        : {
            ...message,
            file: this.attachments.get(message.data.id),
          };
  }
}

// An import as the Apple hosts keep one: its rows, its checkpoints and the
// files it stores in one folder, which the user may move or copy to another
// disk or home.
async function importIn(folder: string, source: Notes, storesFiles: boolean) {
  const destination = new SQLiteDestination({
    path: join(folder, 'data.sqlite'),
  });
  const files = new LocalFiles({ directory: join(folder, 'files') });
  const target = storesFiles
    ? destination.table('notes', (c) => [
        c.text('id'),
        c.text('title'),
        c.text('attachmentRef').from(source.notes.file.store(files)),
      ])
    : destination.table('notes');
  const history = new SQLiteSyncHistory();
  return new Pipeline({
    history,
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({
          path: join(folder, 'checkpoints.sqlite'),
        }),
        steps: [
          new Copy(source.notes, target, {
            id: 'notes',
            syncMode: 'incremental',
            destinationSyncMode: 'append_dedup',
          }),
        ],
      }),
    ],
  });
}

test('a copy resumes from its checkpoint after its database and checkpoint store move to another folder', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-relocated-');
  const before = join(scratch.path, 'before');
  const after = join(scratch.path, 'after');
  await mkdir(before);
  const source = new Notes();
  await (await importIn(before, source, false)).run();

  await rename(before, after);
  const results = await (await importIn(after, source, false)).run();

  assert.deepEqual(
    results.map(({ count, deleted }) => ({ count, deleted })),
    [{ count: 0, deleted: 0 }],
  );
  assert.notEqual(source.received[1], null);
});

test("a moved import's stored files still resolve, and the next load keeps them", async () => {
  await using scratch = await new TemporaryFiles().directory('elt-relocated-');
  const upstream = join(scratch.path, 'upstream');
  const before = join(scratch.path, 'before');
  const after = join(scratch.path, 'after');
  await mkdir(upstream);
  await mkdir(before);
  const source = new Notes();
  const attach = async (id: string, text: string) => {
    const path = join(upstream, `${id}.txt`);
    await writeFile(path, text);
    source.attachments.set(id, path);
  };
  await attach('a', 'milk, eggs');
  await attach('b', 'boarding pass');
  await (await importIn(before, source, true)).run();

  await rename(before, after);
  // A note written after the move stores its file beside the moved ones.
  source.list.push({ id: 'c', title: 'Recipe' });
  await attach('c', 'flour, butter');
  const results = await (await importIn(after, source, true)).run();

  assert.deepEqual(
    results.map(({ count, deleted }) => ({ count, deleted })),
    [{ count: 1, deleted: 0 }],
  );
  using database = new DatabaseSync(join(after, 'data.sqlite'), {
    readOnly: true,
  });
  const stored = database
    .prepare('SELECT id, attachmentRef FROM notes ORDER BY id')
    .all();
  assert.deepEqual(
    await Promise.all(
      stored.map(async ({ id, attachmentRef }) => [
        id,
        await readFile(join(after, 'files', String(attachmentRef)), 'utf8'),
      ]),
    ),
    [
      ['a', 'milk, eggs'],
      ['b', 'boarding pass'],
      ['c', 'flour, butter'],
    ],
  );
});
