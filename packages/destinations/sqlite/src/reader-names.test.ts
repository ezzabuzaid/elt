import assert from 'node:assert/strict';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import {
  Catalog,
  Connection,
  Copy,
  type CopyConfiguration,
  Gauge,
  type LoadedRow,
  Pipeline,
  Rule,
  type RuleResult,
  type RuleValues,
  Source,
  Stream,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
  type SQLiteTable,
  View,
} from './index.ts';

class Unread extends Gauge<number> {
  protected async read(): Promise<number> {
    return 0;
  }
}

// Notes with ids and titles, described as the stream says.
class Notes extends Source {
  readonly identity = 'notes';
  readonly notes: Stream;
  protected readonly catalog: Catalog;

  constructor(title: { type: 'string'; description?: string }) {
    super();
    this.notes = new Stream({
      name: 'notes',
      jsonSchema: {
        type: 'object',
        description: 'Notes a person wrote.',
        properties: {
          id: { type: 'string', description: 'Note id.' },
          title,
        },
        required: ['id', 'title'],
      },
      primaryKey: ['id'],
      supportedSyncModes: ['full_refresh'],
    });
    this.catalog = new Catalog([this.notes]);
  }

  override coverage() {
    return { description: 'test', selection: {} };
  }

  override async currentAsOf() {
    return null;
  }

  // These tests only run and never watch, so no watch reads this gauge.
  override changeSignals(streams: readonly Stream[]) {
    return [{ gauge: new Unread(), streams, interval: 1000, timeout: 1000 }];
  }

  protected override async open() {
    return new AsyncDisposableStack();
  }

  protected override async *extract(configuration: CopyConfiguration) {
    yield {
      stream: configuration.stream.name,
      data: { id: 'note-1', title: 'Groceries' },
    };
  }
}

const length = {
  length: { type: 'integer', description: 'Characters in the title.' },
} as const;

class TitleLength extends Rule<string, typeof length> {
  override readonly key = { name: 'id', description: 'Note id.' };
  override readonly output = length;
  override readonly batch = 10;
  override readonly concurrency = 1;

  override read(row: LoadedRow) {
    return typeof row.id === 'string' && typeof row.title === 'string'
      ? { key: row.id, input: row.title }
      : null;
  }

  override async identity() {
    return 'title-length-1';
  }

  override async compute(
    titles: readonly string[],
  ): Promise<readonly RuleResult<RuleValues<typeof length>>[]> {
    return titles.map((title) => ({ value: { length: title.length } }));
  }
}

test('a table named notes makes the reader view notes over the raw table raw_notes, and the catalog lists notes', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-names-');
  const source = new Notes({ type: 'string', description: 'Note title.' });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });

  await new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  }).run();

  using database = open(destination.path, { readOnly: true });
  assert.deepEqual(
    database
      .prepare(
        `SELECT "type", "name" FROM sqlite_schema WHERE "name" IN ('notes', 'raw_notes') ORDER BY "name"`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { type: 'view', name: 'notes' },
      { type: 'table', name: 'raw_notes' },
    ],
  );
  assert.deepEqual(
    database
      .prepare('SELECT * FROM notes')
      .all()
      .map(({ id, title }) => ({ id, title })),
    [{ id: 'note-1', title: 'Groceries' }],
  );
  assert.deepEqual(
    database
      .prepare(
        `SELECT "kind", "name" FROM catalog WHERE "name" LIKE 'notes%' OR "name" LIKE 'raw_notes%' ORDER BY "name"`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { kind: 'view', name: 'notes' },
      { kind: 'column', name: 'notes.id' },
      { kind: 'column', name: 'notes.loaded_at' },
      { kind: 'column', name: 'notes.title' },
    ],
  );
});

test('stream_status and extraction_coverage name the reader view of each copy, tell that it exists, and have no target_schema', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-names-');
  const source = new Notes({ type: 'string', description: 'Note title.' });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });

  await new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  }).run();

  using database = open(destination.path, { readOnly: true });
  const rows = (query: string) =>
    database
      .prepare(query)
      .all()
      .map((row) => ({ ...row }));
  assert.deepEqual(rows('SELECT stream, target_table FROM stream_status'), [
    { stream: 'notes', target_table: 'notes' },
  ]);
  assert.deepEqual(
    rows('SELECT stream, target_table, target_exists FROM extraction_coverage'),
    [{ stream: 'notes', target_table: 'notes', target_exists: 1 }],
  );
  assert.deepEqual(
    rows(
      `SELECT m."name" FROM sqlite_schema m, pragma_table_info(m."name") p WHERE m."type" IN ('table', 'view') AND p."name" = 'target_schema'`,
    ),
    [],
  );
});

// The names of the tables and views of a file that name notes or lengths.
function namedRelations(path: string) {
  using database = open(path, { readOnly: true });
  return database
    .prepare(
      `SELECT "name" FROM sqlite_schema WHERE "type" IN ('table', 'view') AND ("name" LIKE '%notes%' OR "name" LIKE '%lengths%') ORDER BY "name"`,
    )
    .all()
    .map(({ name }) => name);
}

test('a copy whose stream leaves a field undescribed fails at declaration, naming the field and the stream, and loads nothing', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-names-');
  const source = new Notes({ type: 'string' });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, destination.table('notes'))],
      }),
    ],
  });

  await assert.rejects(
    pipeline.run(),
    /^TypeError: Reader view notes needs JSON Schema descriptions for title of stream notes$/,
  );
  assert.deepEqual(namedRelations(destination.path), []);
});

void test.each(
  [
    'catalog',
    'Catalog',
    'sync_attempts',
    'sync_status',
    'stream_status',
    'extraction_coverage',
    'derived_status',
  ],
  (name) =>
    test(`the reader name ${name}, which the destination makes, is refused`, () => {
      const destination = new SQLiteDestination({
        path: '/nonexistent/notes.sqlite',
      });

      assert.throws(
        () => destination.table(name),
        new RegExp(
          `^TypeError: Reader name ${name} is a relation the destination makes$`,
        ),
        name,
      );
    }),
);

test('a reader name that the destination does not make is accepted', () => {
  const destination = new SQLiteDestination({
    path: '/nonexistent/notes.sqlite',
  });

  assert.equal(destination.table('notes').name, 'notes');
});

test('a view or computed dataset whose relations take the name of a reader view or raw table of a copy in the same file is refused before the pipeline reads', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-names-');
  const source = new Notes({ type: 'string', description: 'Note title.' });
  const destination = new SQLiteDestination({
    path: join(scratch.path, 'notes.sqlite'),
  });
  const notes = destination.table('notes');
  const pipeline = (
    target: SQLiteTable,
    derived: View | ComputedDataset<string>,
  ) =>
    new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          steps: [new Copy(source.notes, target)],
        }),
      ],
      derived: [derived],
    });
  const lengths = (name: string, from: SQLiteTable) =>
    new ComputedDataset({
      into: destination,
      name,
      description: 'Title lengths.',
      from: [from],
      compute: new TitleLength(),
    });

  await assert.rejects(
    pipeline(
      notes,
      new View({
        into: destination,
        name: 'RAW_notes',
        description: 'Notes again.',
        columns: { id: 'Note id.' },
        sql: 'SELECT id FROM notes',
      }),
    ).run(),
    /^TypeError: View RAW_notes has the name of a relation a copy makes$/,
  );
  await assert.rejects(
    pipeline(notes, lengths('raw_notes', notes)).run(),
    /^TypeError: Computed dataset raw_notes needs raw_notes, which a copy of the pipeline makes$/,
  );
  await assert.rejects(
    pipeline(notes, lengths('notes', notes)).run(),
    /^TypeError: Computed dataset notes needs notes, which a copy of the pipeline makes$/,
  );
  const rawLengths = destination.table('raw_lengths');
  await assert.rejects(
    pipeline(rawLengths, lengths('lengths', rawLengths)).run(),
    /^TypeError: Computed dataset lengths needs raw_lengths, which a copy of the pipeline makes$/,
  );
  assert.deepEqual(namedRelations(destination.path), []);
});
