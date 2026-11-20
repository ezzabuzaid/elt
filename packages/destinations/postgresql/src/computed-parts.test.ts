import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { Postgres } from '@zukhruf/testing/postgres';
import postgres from 'postgres';

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

import {
  ComputedDataset,
  PostgresDestination,
  PostgresSyncHistory,
} from './index.ts';

const databases = new Postgres({ environment: process.env });

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
// offsets, one note a call: a note with no text is empty, one whose text
// starts with "bad" fails, and one whose text starts with "throw" fails the
// call. nudges adds to the value of a column of each piece, so a test can
// give a value that is no integer. While handles is false, the rule handles
// no note.
class Pieces extends TableRule<Note, RuleColumns, RuleColumns> {
  readonly key = { name: 'id', description: 'Note id.' };
  readonly output: RuleColumns;
  readonly place: RuleColumns;
  readonly batch = 1;
  readonly concurrency = 1;
  readonly nudges = new Map<'tokens' | 'start', number>();
  handles = true;

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
    return this.handles ? 'pieces-v1' : null;
  }

  async compute(
    notes: readonly Note[],
  ): Promise<readonly TableRuleResult<RuleValues<RuleColumns>>[]> {
    if (notes.some(({ text }) => text.startsWith('throw')))
      throw new Error('the call threw');
    return notes.map(({ id, text }) => {
      if (text === '') return { empty: true };
      if (text.startsWith('bad')) return { error: `${id} is bad` };
      let start = 0;
      const [first, ...rest] = text.split('|').map((piece) => {
        const part = {
          text: piece,
          tokens: piece.length + (this.nudges.get('tokens') ?? 0),
          start: start + (this.nudges.get('start') ?? 0),
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
// marts.notes, and keeps the dataset pieces in marts, with a session to read
// the database.
function pieces(
  url: string,
  clients: AsyncDisposableStack,
  rule = new Pieces(),
) {
  const source = new Notes();
  const marts = new PostgresDestination({ url });
  const target = marts.table('notes');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination: marts,
        steps: [new Copy(source.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: marts,
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [target],
        compute: rule,
      }),
    ],
  });
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (session) => session.end(),
  );
  const rows = async (query: string) => [...(await sql.unsafe(query))];
  return { source, marts, pipeline, rule, rows };
}

async function newest(marts: PostgresDestination): Promise<string> {
  const positions = await marts.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the database has no position yet');
  return position;
}

// What a query showed as of a position.
async function asOf(
  marts: PostgresDestination,
  position: string,
  query: string,
) {
  const reading = await marts.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  await using _ = reading;
  return [...(await reading.sql.unsafe(query))];
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
  'SELECT id, seq, text, start, "end" FROM marts.pieces_parts ORDER BY id, seq';

test('a table rule keeps one output row for each key in the view of the dataset, and each part in <name>_parts with its seq from 0, its part hash, its content and its place, in columns of the Postgres type of each kind', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, pipeline, rows } = pieces(database.connectionString, clients);
  source.rows = [
    { id: 'a', text: 'one|two|one' },
    { id: 'b', text: 'three' },
  ];

  await pipeline.run();

  const declared = (relation: string) =>
    rows(
      `SELECT attname AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute WHERE attrelid = '${relation}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`,
    );
  assert.deepEqual(
    {
      outputs: await rows(
        'SELECT id, rule, status, error FROM marts.pieces ORDER BY id',
      ),
      columns: (await declared('marts.pieces')).map(({ name }) => name),
      parts: await rows(
        'SELECT id, seq, part_hash, text, tokens, start, "end" FROM marts.pieces_parts ORDER BY id, seq',
      ),
      view: (await declared('marts.pieces_parts')).map(({ name }) => name),
      table: await declared('_warehouse.raw_pieces_parts'),
      primaryKey: await rows(
        "SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey) WHERE i.indrelid = '_warehouse.raw_pieces_parts'::regclass AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)",
      ),
    },
    {
      outputs: [
        { id: 'a', rule: 'pieces-v1', status: 'computed', error: null },
        { id: 'b', rule: 'pieces-v1', status: 'computed', error: null },
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
        { name: 'id', type: 'text' },
        { name: 'seq', type: 'integer' },
        { name: 'part_hash', type: 'text' },
        { name: 'text', type: 'text' },
        { name: 'tokens', type: 'bigint' },
        { name: 'start', type: 'bigint' },
        { name: 'end', type: 'bigint' },
        { name: 'committed_in', type: 'integer' },
        { name: '_elt_row_hash', type: 'text' },
      ],
      primaryKey: [{ name: 'id' }, { name: 'seq' }],
    },
  );
});

test('an input that changes at its end keeps the commit of each part that did not change, writes the part that changed, deletes the parts beyond the new list, and a reading before the change shows the old parts with their output row', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, marts, pipeline, rows } = pieces(
    database.connectionString,
    clients,
  );
  source.rows = [{ id: 'a', text: 'one|two|three' }];
  await pipeline.run();
  const before = await newest(marts);
  const committed = () =>
    rows(
      'SELECT seq, committed_in FROM _warehouse.raw_pieces_parts ORDER BY seq',
    );
  const [kept] = await committed();
  const [made] = await rows('SELECT input_hash FROM marts.pieces');
  source.rows = [{ id: 'a', text: 'one|tw' }];

  await pipeline.run();

  const after = await committed();
  assert.deepEqual(
    {
      parts: await rows(parts),
      kept: after[0],
      changed: Number(after[1]?.committed_in) > Number(kept?.committed_in),
      past: await asOf(
        marts,
        before,
        'SELECT o.input_hash, p.seq, p.text FROM marts.pieces AS o JOIN marts.pieces_parts AS p USING (id) ORDER BY p.seq',
      ),
    },
    {
      parts: [
        { id: 'a', seq: 0, text: 'one', start: '0', end: '3' },
        { id: 'a', seq: 1, text: 'tw', start: '4', end: '6' },
      ],
      kept,
      changed: true,
      past: [
        { input_hash: made?.input_hash, seq: 0, text: 'one' },
        { input_hash: made?.input_hash, seq: 1, text: 'two' },
        { input_hash: made?.input_hash, seq: 2, text: 'three' },
      ],
    },
  );
});

test('a part that only moved keeps its part hash and is written with its new place', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, pipeline, rows } = pieces(database.connectionString, clients);
  source.rows = [{ id: 'a', text: 'xx|one' }];
  await pipeline.run();
  const moved =
    'SELECT seq, part_hash, start, "end", committed_in FROM _warehouse.raw_pieces_parts WHERE seq = 1';
  const [before] = await rows(moved);
  source.rows = [{ id: 'a', text: 'x|one' }];

  await pipeline.run();

  const [after] = await rows(moved);
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
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, pipeline, rows } = pieces(database.connectionString, clients);
  source.rows = [
    { id: 'a', text: '' },
    { id: 'b', text: 'bad' },
    { id: 'c', text: 'one|two' },
  ];
  await pipeline.run();
  const first = await rows(parts);
  source.rows = [
    { id: 'a', text: '' },
    { id: 'b', text: 'bad' },
    { id: 'c', text: 'bad again' },
  ];

  await pipeline.run();

  assert.deepEqual(
    {
      first: first.map(({ id, seq }) => `${String(id)}${String(seq)}`),
      outputs: await rows(
        'SELECT id, status, error FROM marts.pieces ORDER BY id',
      ),
      parts: await rows(parts),
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
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, marts, pipeline, rows } = pieces(
    database.connectionString,
    clients,
  );
  source.rows = [
    { id: 'a', text: 'one|two' },
    { id: 'b', text: 'three' },
  ];
  await pipeline.run();
  const before = await newest(marts);
  source.rows = [{ id: 'b', text: 'three' }];

  await pipeline.run();

  assert.deepEqual(
    {
      outputs: await rows('SELECT id FROM marts.pieces ORDER BY id'),
      parts: (await rows(parts)).map(({ id }) => id),
      past: await asOf(
        marts,
        before,
        'SELECT o.id, count(p.seq)::int AS parts FROM marts.pieces AS o JOIN marts.pieces_parts AS p USING (id) GROUP BY o.id ORDER BY o.id',
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

for (const column of ['tokens', 'start'] as const)
  test(`a value of a part that does not fit its column, here ${column}, fails its input with the part and the column named, and the input keeps no part`, async () => {
    await using database = await databases.database();
    await using clients = new AsyncDisposableStack();
    const rule = new Pieces();
    rule.nudges.set(column, 0.5);
    const { source, pipeline, rows } = pieces(
      database.connectionString,
      clients,
      rule,
    );
    source.rows = [{ id: 'a', text: 'one|two' }];

    await pipeline.run();

    assert.deepEqual(
      {
        outputs: await rows('SELECT id, status, error FROM marts.pieces'),
        parts: await rows(parts),
      },
      {
        outputs: [
          {
            id: 'a',
            status: 'failed',
            error: `Part 0: The column ${column} takes a safe integer, and the rule gave ${column === 'tokens' ? 3.5 : 0.5}.`,
          },
        ],
        parts: [],
      },
    );
  });

test('a rule call that fails rejects the run, and each input of the calls before it keeps its output row with all its parts', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, pipeline, rows } = pieces(database.connectionString, clients);
  source.rows = [
    { id: 'a', text: 'one|two' },
    { id: 'b', text: 'throw' },
    { id: 'c', text: 'three' },
  ];

  await assert.rejects(pipeline.run(), /the call threw/);

  assert.deepEqual(
    {
      outputs: await rows('SELECT id, status FROM marts.pieces'),
      parts: (await rows(parts)).map(({ id, seq }) => [id, seq]),
    },
    {
      outputs: [{ id: 'a', status: 'computed' }],
      parts: [
        ['a', 0],
        ['a', 1],
      ],
    },
  );
});

test('a rule that stops handling an input keeps the parts it made before', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, pipeline, rule, rows } = pieces(
    database.connectionString,
    clients,
  );
  source.rows = [{ id: 'a', text: 'one|two' }];
  await pipeline.run();
  rule.handles = false;
  source.rows = [{ id: 'a', text: 'one|two|three' }];

  await pipeline.run();

  assert.deepEqual(
    {
      outputs: await rows('SELECT id, rule, status FROM marts.pieces'),
      parts: (await rows(parts)).map(({ text }) => text),
    },
    {
      outputs: [{ id: 'a', rule: 'pieces-v1', status: 'computed' }],
      parts: ['one', 'two'],
    },
  );
});

test('derived_status counts the inputs and the output rows of a table rule, one for each key, not its parts', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const { source, pipeline, rows } = pieces(database.connectionString, clients);
  source.rows = [
    { id: 'a', text: 'one|two|three' },
    { id: 'b', text: 'four' },
    { id: 'c', text: '' },
  ];

  await pipeline.run();

  assert.deepEqual(
    await rows(
      "SELECT state, inputs::int, computed::int, empty::int, failed::int, pending::int FROM marts.derived_status WHERE dataset = 'marts.pieces'",
    ),
    [
      {
        state: 'current',
        inputs: 3,
        computed: 2,
        empty: 1,
        failed: 0,
        pending: 0,
      },
    ],
  );
});

test('a changed declaration of the parts makes both tables again, a view over <name>_parts reads the new table, and a reading before shows the parts of the old declaration', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const first = pieces(url, clients);
  first.source.rows = [{ id: 'a', text: 'one|two' }];
  await first.pipeline.run();
  await first.rows(
    'CREATE VIEW marts.piece_texts AS SELECT id, text FROM marts.pieces_parts',
  );
  const before = await newest(first.marts);
  const [output] = await first.rows(
    'SELECT committed_in FROM _warehouse.raw_pieces',
  );
  const second = pieces(
    url,
    clients,
    new Pieces({
      place: {
        ...offsets,
        line: { type: 'integer', description: 'The line of the piece.' },
      },
    }),
  );
  second.source.rows = first.source.rows;

  await second.pipeline.run();

  const [remade] = await second.rows(
    'SELECT committed_in FROM _warehouse.raw_pieces',
  );
  assert.deepEqual(
    {
      columns: (
        await second.rows(
          "SELECT attname AS name FROM pg_attribute WHERE attrelid = 'marts.pieces_parts'::regclass AND attnum > 0 ORDER BY attnum",
        )
      ).map(({ name }) => name),
      parts: await second.rows(
        'SELECT seq, text, line FROM marts.pieces_parts ORDER BY seq',
      ),
      view: await second.rows(
        'SELECT id, text FROM marts.piece_texts ORDER BY text',
      ),
      outputRemade: Number(remade?.committed_in) > Number(output?.committed_in),
      past: await asOf(
        second.marts,
        before,
        'SELECT seq, text FROM marts.pieces_parts ORDER BY seq',
      ),
    },
    {
      columns: [
        'id',
        'seq',
        'part_hash',
        'text',
        'tokens',
        'start',
        'end',
        'line',
      ],
      parts: [
        { seq: 0, text: 'one', line: null },
        { seq: 1, text: 'two', line: null },
      ],
      view: [
        { id: 'a', text: 'one' },
        { id: 'a', text: 'two' },
      ],
      outputRemade: true,
      past: [
        { seq: 0, text: 'one' },
        { seq: 1, text: 'two' },
      ],
    },
  );
});

for (const [output, place, column] of [
  [['text', 'seq'], ['start'], 'seq'],
  [['text'], ['part_hash'], 'part_hash'],
  [['text'], ['id'], 'id'],
  [['status'], ['start'], 'status'],
  [['text'], ['input_hash'], 'input_hash'],
  [['rule'], ['start'], 'rule'],
  [['text'], ['error'], 'error'],
  [['text'], ['_elt_row_hash'], '_elt_row_hash'],
  [['text'], ['committed_in'], 'committed_in'],
  [['text'], ['replaced_in'], 'replaced_in'],
  [['text'], ['text'], 'text'],
] as const)
  test(`a table rule column named ${column} is refused when the dataset is constructed, as the dataset already has ${column}`, () => {
    const columns = (names: readonly string[]): RuleColumns =>
      Object.fromEntries(
        names.map((name) => [name, { type: 'text', description: name }]),
      );

    assert.throws(
      () =>
        new ComputedDataset({
          into: new PostgresDestination({
            url: 'postgres://localhost/none',
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
        `Computed dataset pieces cannot have the column ${column}: the dataset already has the column ${column}`,
      ),
    );
  });

test('a table rule column that differs from a column of the dataset only in case is its own column, as Postgres keeps the case of a quoted name', () => {
  assert.doesNotThrow(
    () =>
      new ComputedDataset({
        into: new PostgresDestination({
          url: 'postgres://localhost/none',
        }),
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [],
        compute: new Pieces({
          output: { Part_Hash: { type: 'text', description: 'Part_Hash' } },
          place: { SEQ: { type: 'integer', description: 'SEQ' } },
        }),
      }),
  );
});

test('a computed dataset with a table rule refuses a pipeline whose copy makes pieces_parts, before anything is made', async () => {
  await using database = await databases.database();
  await using clients = new AsyncDisposableStack();
  const url = database.connectionString;
  const sql = clients.adopt(
    postgres(url, { max: 1, onnotice: () => {} }),
    (session) => session.end(),
  );
  const source = new Notes();
  const marts = new PostgresDestination({ url });
  const target = marts.table('pieces_parts');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new PostgresSyncHistory({ url }),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination: marts,
        steps: [new Copy(source.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: marts,
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
    [
      ...(await sql`SELECT to_regclass('_warehouse.raw_pieces') AS dataset, to_regclass('marts.pieces_parts') AS copied`),
    ],
    [{ dataset: null, copied: null }],
  );
});
