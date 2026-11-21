import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  Catalog,
  Connection,
  Copy,
  type LoadedRow,
  Pipeline,
  type RuleColumns,
  type RuleValues,
  Source,
  Stream,
  TableRule,
  type TableRuleResult,
} from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

import {
  ComputedDataset,
  SqlServerDestination,
  type SqlServerIndex,
  type SqlServerLogin,
  SqlServerSyncHistory,
} from './index.ts';

const sqlServer = new SqlServer({
  environment: process.env,
  image: 'mcr.microsoft.com/mssql/server:2025-latest',
});

// A database of its own for one test, which keeps row versions for readers.
async function scratch() {
  const database = await sqlServer.database();
  const login: SqlServerLogin = {
    server: database.host,
    port: database.port,
    database: database.database,
    user: database.user,
    password: database.password,
    trustServerCertificate: true,
  };
  const admin = await new SqlServerDatabase(login).connect();
  await admin.query(
    `ALTER DATABASE [${database.database}] SET ALLOW_SNAPSHOT_ISOLATION ON; ALTER DATABASE [${database.database}] SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE`,
  );
  return {
    login,
    admin,
    rows: async (query: string) =>
      (await admin.query(query)).map((row) => ({ ...row })),
    async [Symbol.asyncDispose]() {
      await admin[Symbol.asyncDispose]();
      await database[Symbol.asyncDispose]();
    },
  };
}

type Note = { readonly id: string; readonly text: string };

// Notes the test sets before each run, copied in full each pass.
class Notes extends Source {
  readonly identity = 'notes';
  rows: readonly Note[] = [];
  readonly notes = new Stream({
    name: 'notes',
    jsonSchema: {
      type: 'object',
      description: 'A note.',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        text: { type: 'string', description: 'The text of the note.' },
      },
      required: ['id', 'text'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
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

  // No test watches: each runs the pipeline itself.
  override changeSignals() {
    return [];
  }

  protected override async *extract() {
    for (const row of this.rows) yield { stream: 'notes', data: row };
  }
}

const content = {
  text: { type: 'text', description: 'The text of the piece.' },
  tokens: { type: 'integer', description: 'How long the piece is.' },
} as const satisfies RuleColumns;

const offsets = {
  start: { type: 'integer', description: 'Where the piece starts.' },
  end: { type: 'integer', description: 'Where the piece ends.' },
} as const satisfies RuleColumns;

// The pieces of a note's text between bars, each with its length and its
// offsets: a note with no text is empty, and one whose text starts with
// "bad" fails.
class Pieces extends TableRule<Note, RuleColumns, RuleColumns> {
  readonly key = { name: 'id', description: 'Note id.' };
  readonly output: RuleColumns;
  readonly place: RuleColumns;
  readonly batch = 10;
  readonly concurrency = 1;

  constructor({
    output = content,
    place = offsets,
  }: { output?: RuleColumns; place?: RuleColumns } = {}) {
    super();
    this.output = output;
    this.place = place;
  }

  read(row: LoadedRow) {
    return {
      key: String(row.id),
      input: { id: String(row.id), text: String(row.text) },
    };
  }

  async identity() {
    return 'pieces-v1';
  }

  async compute(
    notes: readonly Note[],
  ): Promise<readonly TableRuleResult<RuleValues<RuleColumns>>[]> {
    return notes.map(({ id, text }) => {
      if (text === '') return { empty: true };
      if (text.startsWith('bad')) return { error: `${id} is bad` };
      let start = 0;
      const [first, ...rest] = text.split('|').map((piece) => {
        const part = {
          text: piece,
          tokens: piece.length,
          start,
          end: start + piece.length,
        };
        start += piece.length + 1;
        return part;
      });
      return first === undefined
        ? { empty: true }
        : { parts: [first, ...rest] };
    });
  }
}

// A pipeline that copies notes into _warehouse.raw_notes, read through
// marts.notes, and keeps the dataset pieces in marts.
function pieces(
  login: SqlServerLogin,
  rule = new Pieces(),
  indexes: {
    indexes?: readonly SqlServerIndex[];
    partIndexes?: readonly SqlServerIndex[];
  } = {},
) {
  const source = new Notes();
  const destination = new SqlServerDestination({ login });
  const target = destination.table('notes');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [target],
        compute: rule,
        ...indexes,
      }),
    ],
  });
  return { source, destination, pipeline };
}

async function newest(destination: SqlServerDestination): Promise<string> {
  const positions = await destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the database has no position yet');
  return position;
}

// What a query showed as of a position.
async function asOf(
  destination: SqlServerDestination,
  position: string,
  query: string,
) {
  const reading = await destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _ = reading;
  return (await reading.sql.query(query)).map((row) => ({ ...row }));
}

// The part hash as elt documents it, over the content columns text and
// tokens, in the order of their names.
function partHash(text: string, tokens: number): string {
  const digest = createHash('sha256');
  for (const [tag, value] of [
    ['c', 'text'],
    ['t', text],
    ['c', 'tokens'],
    ['n', String(tokens)],
  ] as const) {
    digest.update(`${tag}${Buffer.byteLength(value)}:`);
    digest.update(value);
  }
  return digest.digest('hex');
}

const parts =
  'SELECT [id], [seq], [text], [start], [end] FROM marts.pieces_parts ORDER BY [id], [seq]';

const committed =
  'SELECT [seq], [part_hash], [start], [end], [committed_in] FROM _warehouse.raw_pieces_parts ORDER BY [seq]';

test('a table rule keeps one output row for each key in marts.<name>, and each part in marts.<name>_parts with its seq from 0, its part hash, its content and its place, unique on the key hash and seq, and derived_status counts the output rows', async () => {
  await using database = await scratch();
  const { source, pipeline } = pieces(database.login);
  source.rows = [
    { id: 'a', text: 'one|two|one' },
    { id: 'b', text: 'three' },
    { id: 'c', text: '' },
  ];

  await pipeline.run();

  const declared = (relation: string) =>
    database.rows(
      `SELECT c.[name], TYPE_NAME(c.[user_type_id]) AS [type], c.[max_length] AS [length], c.[is_nullable] AS [nullable] FROM sys.columns AS c WHERE c.[object_id] = OBJECT_ID(N'${relation}') ORDER BY c.[column_id]`,
    );
  assert.deepEqual(
    {
      outputs: await database.rows(
        'SELECT [id], [rule], [status], [error] FROM marts.pieces ORDER BY [id]',
      ),
      columns: (await declared('marts.pieces')).map(({ name }) => name),
      parts: await database.rows(
        'SELECT [id], [seq], [part_hash], [text], [tokens], [start], [end] FROM marts.pieces_parts ORDER BY [id], [seq]',
      ),
      view: (await declared('marts.pieces_parts')).map(({ name }) => name),
      table: await declared('_warehouse.raw_pieces_parts'),
      indexes: await database.rows(
        "SELECT i.[type_desc] AS [kind], i.[is_unique] AS [unique], STRING_AGG(c.[name], N',') WITHIN GROUP (ORDER BY ic.[key_ordinal]) AS [columns] FROM sys.indexes AS i JOIN sys.index_columns AS ic ON ic.[object_id] = i.[object_id] AND ic.[index_id] = i.[index_id] JOIN sys.columns AS c ON c.[object_id] = ic.[object_id] AND c.[column_id] = ic.[column_id] WHERE i.[object_id] = OBJECT_ID(N'_warehouse.raw_pieces_parts') GROUP BY i.[type_desc], i.[is_unique] ORDER BY [kind]",
      ),
      status: await database.rows(
        "SELECT [state], CAST([inputs] AS int) AS [inputs], CAST([computed] AS int) AS [computed], CAST([empty] AS int) AS [empty], CAST([pending] AS int) AS [pending] FROM marts.derived_status WHERE [dataset] = N'marts.pieces'",
      ),
    },
    {
      outputs: [
        { id: 'a', rule: 'pieces-v1', status: 'computed', error: null },
        { id: 'b', rule: 'pieces-v1', status: 'computed', error: null },
        { id: 'c', rule: 'pieces-v1', status: 'empty', error: null },
      ],
      columns: ['id', 'input_hash', 'rule', 'status', 'error'],
      parts: [
        {
          id: 'a',
          seq: 0,
          part_hash: partHash('one', 3),
          text: 'one',
          tokens: '3',
          start: '0',
          end: '3',
        },
        {
          id: 'a',
          seq: 1,
          part_hash: partHash('two', 3),
          text: 'two',
          tokens: '3',
          start: '4',
          end: '7',
        },
        {
          id: 'a',
          seq: 2,
          part_hash: partHash('one', 3),
          text: 'one',
          tokens: '3',
          start: '8',
          end: '11',
        },
        {
          id: 'b',
          seq: 0,
          part_hash: partHash('three', 5),
          text: 'three',
          tokens: '5',
          start: '0',
          end: '5',
        },
      ],
      view: ['id', 'seq', 'part_hash', 'text', 'tokens', 'start', 'end'],
      table: [
        { name: '_elt_row', type: 'bigint', length: 8, nullable: false },
        { name: 'id', type: 'nvarchar', length: -1, nullable: false },
        { name: 'seq', type: 'int', length: 4, nullable: false },
        { name: 'part_hash', type: 'nvarchar', length: -1, nullable: false },
        { name: 'text', type: 'nvarchar', length: -1, nullable: true },
        { name: 'tokens', type: 'bigint', length: 8, nullable: true },
        { name: 'start', type: 'bigint', length: 8, nullable: true },
        { name: 'end', type: 'bigint', length: 8, nullable: true },
        { name: 'committed_in', type: 'bigint', length: 8, nullable: false },
        { name: '_elt_row_hash', type: 'binary', length: 32, nullable: false },
        { name: '_elt_key_hash', type: 'binary', length: 32, nullable: false },
      ],
      indexes: [
        { kind: 'CLUSTERED', unique: true, columns: '_elt_row' },
        { kind: 'NONCLUSTERED', unique: true, columns: '_elt_key_hash,seq' },
      ],
      status: [
        { state: 'current', inputs: 3, computed: 2, empty: 1, pending: 0 },
      ],
    },
  );
});

test('an input that changes at its end keeps the commit of each part that did not change, writes the part that changed, removes the parts beyond the new list, and a reading before the change shows the old parts with their output row', async () => {
  await using database = await scratch();
  const { source, destination, pipeline } = pieces(database.login);
  source.rows = [{ id: 'a', text: 'one|two|three' }];
  await pipeline.run();
  const before = await newest(destination);
  const [kept, changed] = await database.rows(committed);
  const [made] = await database.rows('SELECT [input_hash] FROM marts.pieces');
  source.rows = [{ id: 'a', text: 'one|tw' }];

  await pipeline.run();

  const after = await database.rows(committed);
  assert.deepEqual(
    {
      parts: await database.rows(parts),
      kept: after[0],
      written: Number(after[1]?.committed_in) > Number(changed?.committed_in),
      past: await asOf(
        destination,
        before,
        'SELECT o.[input_hash], p.[seq], p.[text] FROM marts.pieces AS o JOIN marts.pieces_parts AS p ON p.[id] = o.[id] ORDER BY p.[seq]',
      ),
    },
    {
      parts: [
        { id: 'a', seq: 0, text: 'one', start: '0', end: '3' },
        { id: 'a', seq: 1, text: 'tw', start: '4', end: '6' },
      ],
      kept,
      written: true,
      past: [
        { input_hash: made?.input_hash, seq: 0, text: 'one' },
        { input_hash: made?.input_hash, seq: 1, text: 'two' },
        { input_hash: made?.input_hash, seq: 2, text: 'three' },
      ],
    },
  );
});

test('a part that only moved keeps its part hash and is written with its new place', async () => {
  await using database = await scratch();
  const { source, pipeline } = pieces(database.login);
  source.rows = [{ id: 'a', text: 'xx|one' }];
  await pipeline.run();
  const [, before] = await database.rows(committed);
  source.rows = [{ id: 'a', text: 'x|one' }];

  await pipeline.run();

  const [, after] = await database.rows(committed);
  assert.deepEqual(
    {
      hash: after?.part_hash,
      place: [after?.start, after?.end],
      written: Number(after?.committed_in) > Number(before?.committed_in),
    },
    { hash: before?.part_hash, place: ['2', '5'], written: true },
  );
});

test('an input that is empty or failed has no parts, and an input whose parts were kept loses them when it fails', async () => {
  await using database = await scratch();
  const { source, pipeline } = pieces(database.login);
  source.rows = [
    { id: 'a', text: '' },
    { id: 'b', text: 'bad' },
    { id: 'c', text: 'one|two' },
  ];
  await pipeline.run();
  const first = await database.rows(parts);
  source.rows = [
    { id: 'a', text: '' },
    { id: 'b', text: 'bad' },
    { id: 'c', text: 'bad again' },
  ];

  await pipeline.run();

  assert.deepEqual(
    {
      first: first.map(({ id, seq }) => `${String(id)}${String(seq)}`),
      outputs: await database.rows(
        'SELECT [id], [status], [error] FROM marts.pieces ORDER BY [id]',
      ),
      parts: await database.rows(parts),
    },
    {
      first: ['c0', 'c1'],
      outputs: [
        { id: 'a', status: 'empty', error: null },
        { id: 'b', status: 'failed', error: 'b is bad' },
        { id: 'c', status: 'failed', error: 'c is bad' },
      ],
      parts: [],
    },
  );
});

test('a removed input removes its output row and its parts, and a reading before the removal still shows them', async () => {
  await using database = await scratch();
  const { source, destination, pipeline } = pieces(database.login);
  source.rows = [
    { id: 'a', text: 'one|two' },
    { id: 'b', text: 'three' },
  ];
  await pipeline.run();
  const before = await newest(destination);
  source.rows = [{ id: 'b', text: 'three' }];

  await pipeline.run();

  assert.deepEqual(
    {
      outputs: await database.rows('SELECT [id] FROM marts.pieces'),
      parts: (await database.rows(parts)).map(({ id }) => id),
      past: await asOf(
        destination,
        before,
        'SELECT o.[id], COUNT(p.[seq]) AS [parts] FROM marts.pieces AS o JOIN marts.pieces_parts AS p ON p.[id] = o.[id] GROUP BY o.[id] ORDER BY o.[id]',
      ),
    },
    {
      outputs: [{ id: 'b' }],
      parts: ['b'],
      past: [
        { id: 'a', parts: 2 },
        { id: 'b', parts: 1 },
      ],
    },
  );
});

test('a changed declaration of the parts makes both tables again in one commit, a view over <name>_parts reads the new table, and a reading before shows the parts of the old declaration', async () => {
  await using database = await scratch();
  const first = pieces(database.login);
  first.source.rows = [{ id: 'a', text: 'one|two' }];
  await first.pipeline.run();
  await database.admin.query(
    'CREATE VIEW marts.piece_texts AS SELECT * FROM marts.pieces_parts',
  );
  const before = await newest(first.destination);
  const [output] = await database.rows(
    'SELECT [committed_in] FROM _warehouse.raw_pieces',
  );
  const second = pieces(
    database.login,
    new Pieces({
      place: {
        ...offsets,
        line: { type: 'integer', description: 'The line of the piece.' },
      },
    }),
  );
  second.source.rows = first.source.rows;

  await second.pipeline.run();

  const [remade] = await database.rows(
    'SELECT [committed_in] FROM _warehouse.raw_pieces',
  );
  assert.deepEqual(
    {
      parts: await database.rows(
        'SELECT [seq], [text], [line] FROM marts.pieces_parts ORDER BY [seq]',
      ),
      view: await database.rows(
        'SELECT [id], [text], [line] FROM marts.piece_texts ORDER BY [seq]',
      ),
      outputRemade: Number(remade?.committed_in) > Number(output?.committed_in),
      past: await asOf(
        second.destination,
        before,
        'SELECT [seq], [text] FROM marts.pieces_parts ORDER BY [seq]',
      ),
    },
    {
      parts: [
        { seq: 0, text: 'one', line: null },
        { seq: 1, text: 'two', line: null },
      ],
      view: [
        { id: 'a', text: 'one', line: null },
        { id: 'a', text: 'two', line: null },
      ],
      outputRemade: true,
      past: [
        { seq: 0, text: 'one' },
        { seq: 1, text: 'two' },
      ],
    },
  );
});

test('a table rule indexes its parts table and its raw table each by its own declaration', async () => {
  await using database = await scratch();
  const { source, pipeline } = pieces(database.login, new Pieces(), {
    indexes: [{ type: 'nonclustered', columns: ['committed_in'] }],
    partIndexes: [{ type: 'nonclustered', columns: ['tokens', 'seq'] }],
  });
  source.rows = [{ id: 'n1', text: 'ab|c' }];

  await pipeline.run();

  const indexes = (table: string) =>
    database.rows(
      `SELECT STRING_AGG(c.[name], N',') WITHIN GROUP (ORDER BY ic.[key_ordinal]) AS [columns]
       FROM sys.indexes AS i
       JOIN sys.index_columns AS ic ON ic.[object_id] = i.[object_id] AND ic.[index_id] = i.[index_id]
       JOIN sys.columns AS c ON c.[object_id] = ic.[object_id] AND c.[column_id] = ic.[column_id]
       WHERE i.[object_id] = OBJECT_ID(N'${table}') AND i.[name] LIKE N'ix[_]elt[_]%'
       GROUP BY i.[name]`,
    );
  assert.deepEqual(
    {
      raw: await indexes('_warehouse.raw_pieces'),
      parts: await indexes('_warehouse.raw_pieces_parts'),
    },
    {
      raw: [{ columns: 'committed_in' }],
      parts: [{ columns: 'tokens,seq' }],
    },
  );
});

test('an index of the parts table on a column that only the raw table has is refused when the dataset is constructed', () => {
  assert.throws(
    () =>
      new ComputedDataset({
        into: new SqlServerDestination({ login: 'Server=none;Database=none' }),
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [],
        compute: new Pieces(),
        partIndexes: [{ type: 'nonclustered', columns: ['input_hash'] }],
      }),
    new TypeError(
      'Computed dataset pieces declares an index on input_hash, which [_warehouse].[raw_pieces_parts] does not have',
    ),
  );
});

// Pieces whose parts each have a vector of 3 dimensions.
const vectorPieces = () =>
  new Pieces({
    output: {
      ...content,
      vector: {
        type: 'vector',
        dimensions: 3,
        description: 'The piece as a vector.',
      },
    },
  });

test('two vector indexes of the parts table are refused when the dataset is constructed, as marts.pieces_parts_nearest searches one', () => {
  assert.throws(
    () =>
      new ComputedDataset({
        into: new SqlServerDestination({ login: 'Server=none;Database=none' }),
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [],
        compute: vectorPieces(),
        partIndexes: [
          { type: 'vector', column: 'vector', metric: 'cosine' },
          { type: 'vector', column: 'vector', metric: 'dot' },
        ],
      }),
    new TypeError(
      'Computed dataset pieces declares 2 vector indexes on [_warehouse].[raw_pieces_parts], and [marts].[pieces_parts_nearest] searches one',
    ),
  );
});

test('a computed dataset with a vector index of its parts refuses a pipeline whose copy makes Pieces_Parts_Nearest, before anything is made', async () => {
  await using database = await scratch();
  const source = new Notes();
  const destination = new SqlServerDestination({ login: database.login });
  const target = destination.table('Pieces_Parts_Nearest');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [target],
        compute: vectorPieces(),
        partIndexes: [{ type: 'vector', column: 'vector', metric: 'cosine' }],
      }),
    ],
  });

  await assert.rejects(
    pipeline.run(),
    new TypeError(
      'Computed dataset pieces needs marts.pieces_parts_nearest, which a copy of the pipeline makes',
    ),
  );
  assert.deepEqual(
    await database.rows(
      "SELECT OBJECT_ID(N'_warehouse.raw_pieces') AS [dataset], OBJECT_ID(N'marts.Pieces_Parts_Nearest') AS [copied]",
    ),
    [{ dataset: null, copied: null }],
  );
});

test('a computed dataset with a table rule refuses a pipeline whose copy makes Pieces_Parts, in another case, before anything is made', async () => {
  await using database = await scratch();
  const source = new Notes();
  const destination = new SqlServerDestination({ login: database.login });
  const target = destination.table('Pieces_Parts');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SqlServerSyncHistory({ login: database.login }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [target],
        compute: new Pieces(),
      }),
    ],
  });

  await assert.rejects(
    pipeline.run(),
    new TypeError(
      'Computed dataset pieces needs marts.pieces_parts, which a copy of the pipeline makes',
    ),
  );
  assert.deepEqual(
    await database.rows(
      "SELECT OBJECT_ID(N'_warehouse.raw_pieces') AS [dataset], OBJECT_ID(N'marts.Pieces_Parts') AS [copied]",
    ),
    [{ dataset: null, copied: null }],
  );
});

for (const [output, place, column, taken] of [
  [['text'], ['SEQ'], 'SEQ', 'seq'],
  [['text'], ['part_hash'], 'part_hash', 'part_hash'],
  [['text'], ['_elt_row'], '_elt_row', '_elt_row'],
  [['_ELT_KEY_HASH'], ['start'], '_ELT_KEY_HASH', '_elt_key_hash'],
  [['text'], ['Text'], 'Text', 'text'],
] as const)
  test(`a table rule column named ${column} is refused when the dataset is constructed, as the dataset already has ${taken} and SQL Server compares names without case`, () => {
    const columns = (names: readonly string[]): RuleColumns =>
      Object.fromEntries(
        names.map((name) => [name, { type: 'text', description: name }]),
      );

    assert.throws(
      () =>
        new ComputedDataset({
          into: new SqlServerDestination({
            login: 'Server=none;Database=none',
          }),
          name: 'pieces',
          description: 'The pieces of each note.',
          from: [],
          compute: new Pieces({
            output: columns(output),
            place: columns(place),
          }),
        }),
      new TypeError(
        `Computed dataset pieces cannot have the column ${column}: the dataset already has the column ${taken}`,
      ),
    );
  });
