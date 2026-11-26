import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import {
  Connection,
  Copy,
  IterableSource,
  type LoadedRow,
  Pipeline,
  type RuleColumns,
  type RuleValues,
  TableRule,
  type TableRuleResult,
} from '@eltjs/elt';

import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from './index.ts';

type Note = { readonly id: string; readonly text: string };

// Notes the test sets before each run, copied in full each pass.
function notesSource() {
  const host: { rows: readonly Note[] } = { rows: [] };
  const source = new IterableSource({
    identity: 'notes',
    streams: {
      notes: {
        description: 'The notes that the test sets.',
        jsonSchema: {
          description: 'One notes record.',
          type: 'object',
          properties: {
            id: { description: 'Id of the record.', type: 'string' },
            text: { description: 'Text of the record.', type: 'string' },
          },
          required: ['id', 'text'],
        },
        primaryKey: ['id'],
        snapshot: () => host.rows,
      },
    },
  });
  return { host, source };
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

function pieces(directory: string, rule = new Pieces()) {
  const { host, source } = notesSource();
  const destination = new SQLiteDestination({
    path: join(directory, 'data.sqlite'),
  });
  const target = destination.table('notes');
  const pipeline = new Pipeline({
    clock: globalThis,
    history: new SQLiteSyncHistory(),
    connections: [
      new Connection({
        name: 'notes',
        source,
        destination,
        steps: [new Copy(source.streams.notes, target)],
      }),
    ],
    derived: [
      new ComputedDataset({
        into: destination,
        name: 'pieces',
        description: 'The pieces of each note.',
        from: [target],
        compute: rule,
      }),
    ],
  });
  return { host, destination, pipeline, rule };
}

function rows(path: string, sql: string) {
  using database = open(path, { readOnly: true });
  return database
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
}

function newest(destination: SQLiteDestination): string {
  const positions = destination.positions();
  if ('expired' in positions) assert.fail(positions.expired);
  const position = positions.at(-1);
  if (position === undefined) assert.fail('the file has no position yet');
  return position;
}

// What a query showed as of a position.
function asOf(destination: SQLiteDestination, position: string, sql: string) {
  const reading = destination.reading(position);
  if ('expired' in reading) assert.fail(reading.expired);
  using _ = reading;
  return reading.sql
    .prepare(sql)
    .all()
    .map((row) => ({ ...row }));
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
  'SELECT id, seq, text, start, "end" FROM pieces_parts ORDER BY id, seq';

test('a table rule keeps one output row for each key in the view of the dataset, and each part in <name>_parts with its seq from 0, its part hash, its content and its place', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [
    { id: 'a', text: 'one|two|one' },
    { id: 'b', text: 'three' },
  ];

  await pipeline.run();

  assert.deepEqual(
    {
      outputs: rows(
        destination.path,
        'SELECT id, rule, status, error FROM pieces ORDER BY id',
      ),
      columns: rows(
        destination.path,
        "SELECT name FROM pragma_table_info('pieces')",
      ).map(({ name }) => name),
      parts: rows(
        destination.path,
        'SELECT id, seq, part_hash, text, tokens, start, "end" FROM pieces_parts ORDER BY id, seq',
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
          tokens: 3,
          start: 0,
          end: 3,
        },
        {
          id: 'a',
          seq: 1,
          part_hash: partHash('two', 3),
          text: 'two',
          tokens: 3,
          start: 4,
          end: 7,
        },
        {
          id: 'a',
          seq: 2,
          part_hash: partHash('one', 3),
          text: 'one',
          tokens: 3,
          start: 8,
          end: 11,
        },
        {
          id: 'b',
          seq: 0,
          part_hash: partHash('three', 5),
          text: 'three',
          tokens: 5,
          start: 0,
          end: 5,
        },
      ],
    },
  );
});

test('an input that changes at its end keeps the commit of each part that did not change, writes the part that changed, deletes the parts beyond the new list, and a reading before the change shows the old parts with their output row', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [{ id: 'a', text: 'one|two|three' }];
  await pipeline.run();
  const before = newest(destination);
  const committed = () =>
    rows(
      destination.path,
      'SELECT seq, committed_in FROM raw_pieces_parts ORDER BY seq',
    );
  const [kept] = committed();
  const [made] = rows(destination.path, 'SELECT input_hash FROM pieces');
  host.rows = [{ id: 'a', text: 'one|tw' }];

  await pipeline.run();

  const after = committed();
  assert.deepEqual(
    {
      parts: rows(destination.path, parts),
      kept: after[0],
      changed: Number(after[1]?.committed_in) > Number(kept?.committed_in),
      past: asOf(
        destination,
        before,
        'SELECT o.input_hash, p.seq, p.text FROM pieces AS o JOIN pieces_parts AS p USING (id) ORDER BY p.seq',
      ),
    },
    {
      parts: [
        { id: 'a', seq: 0, text: 'one', start: 0, end: 3 },
        { id: 'a', seq: 1, text: 'tw', start: 4, end: 6 },
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
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [{ id: 'a', text: 'xx|one' }];
  await pipeline.run();
  const moved =
    'SELECT seq, part_hash, start, "end", committed_in FROM raw_pieces_parts WHERE seq = 1';
  const [before] = rows(destination.path, moved);
  host.rows = [{ id: 'a', text: 'x|one' }];

  await pipeline.run();

  const [after] = rows(destination.path, moved);
  assert.deepEqual(
    {
      hash: after?.part_hash,
      place: [after?.start, after?.end],
      written: Number(after?.committed_in) > Number(before?.committed_in),
    },
    { hash: before?.part_hash, place: [2, 5], written: true },
  );
});

test('an input that is empty or failed has no parts, and an input whose parts were kept loses them when it fails', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [
    { id: 'a', text: '' },
    { id: 'b', text: 'bad' },
    { id: 'c', text: 'one|two' },
  ];
  await pipeline.run();
  const first = rows(destination.path, parts);
  host.rows = [
    { id: 'a', text: '' },
    { id: 'b', text: 'bad' },
    { id: 'c', text: 'bad again' },
  ];

  await pipeline.run();

  assert.deepEqual(
    {
      first: first.map(({ id, seq }) => `${String(id)}${String(seq)}`),
      outputs: rows(
        destination.path,
        'SELECT id, status, error FROM pieces ORDER BY id',
      ),
      parts: rows(destination.path, parts),
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
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [
    { id: 'a', text: 'one|two' },
    { id: 'b', text: 'three' },
  ];
  await pipeline.run();
  const before = newest(destination);
  host.rows = [{ id: 'b', text: 'three' }];

  await pipeline.run();

  assert.deepEqual(
    {
      outputs: rows(destination.path, 'SELECT id FROM pieces ORDER BY id'),
      parts: rows(destination.path, parts).map(({ id }) => id),
      past: asOf(
        destination,
        before,
        'SELECT o.id, count(p.seq) AS parts FROM pieces AS o JOIN pieces_parts AS p USING (id) GROUP BY o.id ORDER BY o.id',
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

void test.each(['tokens', 'start'] as const, (column) =>
  test(`a value of a part that does not fit its column, here ${column}, fails its input with the part and the column named, and the input keeps no part`, async () => {
    await using scratch = await new TemporaryFiles().directory('elt-parts-');
    const rule = new Pieces();
    rule.nudges.set(column, 0.5);
    const { host, destination, pipeline } = pieces(scratch.path, rule);
    host.rows = [{ id: 'a', text: 'one|two' }];

    await pipeline.run();

    assert.deepEqual(
      {
        outputs: rows(destination.path, 'SELECT id, status, error FROM pieces'),
        parts: rows(destination.path, parts),
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
  }),
);

test('a rule call that fails rejects the run, and each input of the calls before it keeps its output row with all its parts', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [
    { id: 'a', text: 'one|two' },
    { id: 'b', text: 'throw' },
    { id: 'c', text: 'three' },
  ];

  await assert.rejects(pipeline.run(), /the call threw/);

  assert.deepEqual(
    {
      outputs: rows(destination.path, 'SELECT id, status FROM pieces'),
      parts: rows(destination.path, parts).map(({ id, seq }) => [id, seq]),
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
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline, rule } = pieces(scratch.path);
  host.rows = [{ id: 'a', text: 'one|two' }];
  await pipeline.run();
  rule.handles = false;
  host.rows = [{ id: 'a', text: 'one|two|three' }];

  await pipeline.run();

  assert.deepEqual(
    {
      outputs: rows(destination.path, 'SELECT id, rule, status FROM pieces'),
      parts: rows(destination.path, parts).map(({ text }) => text),
    },
    {
      outputs: [{ id: 'a', rule: 'pieces-v1', status: 'computed' }],
      parts: ['one', 'two'],
    },
  );
});

test('derived_status counts the inputs and the output rows of a table rule, one for each key, not its parts', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const { host, destination, pipeline } = pieces(scratch.path);
  host.rows = [
    { id: 'a', text: 'one|two|three' },
    { id: 'b', text: 'four' },
    { id: 'c', text: '' },
  ];

  await pipeline.run();

  assert.deepEqual(
    rows(
      destination.path,
      "SELECT state, inputs, computed, empty, failed, pending FROM derived_status WHERE dataset = 'pieces'",
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

test('a changed declaration of the parts makes both tables again, and a reading before shows the parts of the old declaration', async () => {
  await using scratch = await new TemporaryFiles().directory('elt-parts-');
  const first = pieces(scratch.path);
  first.host.rows = [{ id: 'a', text: 'one|two' }];
  await first.pipeline.run();
  const before = newest(first.destination);
  const [output] = rows(
    first.destination.path,
    'SELECT committed_in FROM raw_pieces',
  );
  const second = pieces(
    scratch.path,
    new Pieces({
      place: {
        ...offsets,
        line: { type: 'integer', description: 'The line of the piece.' },
      },
    }),
  );
  second.host.rows = first.host.rows;

  await second.pipeline.run();

  const [remade] = rows(
    second.destination.path,
    'SELECT committed_in FROM raw_pieces',
  );
  assert.deepEqual(
    {
      columns: rows(
        second.destination.path,
        "SELECT name FROM pragma_table_info('pieces_parts')",
      ).map(({ name }) => name),
      parts: rows(
        second.destination.path,
        'SELECT seq, text, line FROM pieces_parts ORDER BY seq',
      ),
      outputRemade: Number(remade?.committed_in) > Number(output?.committed_in),
      past: asOf(
        second.destination,
        before,
        'SELECT seq, text FROM pieces_parts ORDER BY seq',
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
      outputRemade: true,
      past: [
        { seq: 0, text: 'one' },
        { seq: 1, text: 'two' },
      ],
    },
  );
});

void test.each(
  [
    [['text', 'seq'], ['start'], 'seq', 'seq'],
    [['text'], ['Part_Hash'], 'Part_Hash', 'part_hash'],
    [['text'], ['ID'], 'ID', 'id'],
    [['status'], ['start'], 'status', 'status'],
    [['text'], ['Committed_In'], 'Committed_In', 'committed_in'],
    [['text'], ['REPLACED_IN'], 'REPLACED_IN', 'replaced_in'],
    [['text'], ['TEXT'], 'TEXT', 'text'],
  ] as const,
  ([output, place, column, other]) =>
    test(`a table rule column named ${column} is refused when the dataset is constructed, as the dataset already has ${other}`, () => {
      const columns = (names: readonly string[]): RuleColumns =>
        Object.fromEntries(
          names.map((name) => [name, { type: 'text', description: name }]),
        );

      assert.throws(
        () =>
          new ComputedDataset({
            into: new SQLiteDestination({ path: ':memory:' }),
            name: 'pieces',
            description: 'The pieces of each note.',
            from: [],
            compute: new Pieces({
              output: columns(output),
              place: columns(place),
            }),
          }),
        new TypeError(
          `Computed dataset pieces cannot have the column ${column}: the dataset already has the column ${other}`,
        ),
      );
    }),
);

void test.each(['pieces_parts', 'RAW_PIECES_PARTS'], (name) =>
  test(`a computed dataset with a table rule refuses a pipeline whose copy makes ${name}`, async () => {
    await using scratch = await new TemporaryFiles().directory('elt-parts-');
    const { source } = notesSource();
    const destination = new SQLiteDestination({
      path: join(scratch.path, 'data.sqlite'),
    });
    const target = destination.table(name);
    const pipeline = new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'notes',
          source,
          destination,
          steps: [new Copy(source.streams.notes, target)],
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
        `Computed dataset pieces needs ${name.toLowerCase()}, which a copy of the pipeline makes`,
      ),
    );
  }),
);

test('a table rule gives one part or more for an input: a list of no parts does not compile', () => {
  const results: TableRuleResult<RuleValues<typeof content>>[] = [
    { parts: [{ text: 'one', tokens: 3 }] },
    { empty: true },
    // @ts-expect-error -- an input with no parts is empty
    { parts: [] },
  ];

  assert.equal(results.length, 3);
});
