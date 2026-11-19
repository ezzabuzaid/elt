import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { open } from '@zukhruf/sqlite-open';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';

import {
  Catalog,
  Connection,
  Copy,
  Pipeline,
  Source,
  Stream,
} from '@eltjs/elt';
import {
  ComputedDataset,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@eltjs/elt-sqlite';

import manifest from '../package.json' with { type: 'json' };
import { Chunking, type Tokenizer } from './chunking.ts';

// The vocabulary of OpenAI's text-embedding-3-small.
const cl100k: Tokenizer = { name: 'cl100k_base', count: countTokens };

type Document = {
  readonly id: string;
  readonly title: string | null;
  readonly body: string | null;
};

// Documents the test sets before each run, copied in full each pass.
class Documents extends Source {
  readonly identity = 'documents';
  rows: readonly Document[] = [];
  readonly documents = new Stream({
    name: 'documents',
    jsonSchema: {
      type: 'object',
      description: 'A document.',
      properties: {
        id: { type: 'string', description: 'Document id.' },
        title: { type: ['string', 'null'], description: 'Title.' },
        body: { type: ['string', 'null'], description: 'Text.' },
      },
      required: ['id', 'title', 'body'],
    },
    primaryKey: ['id'],
    supportedSyncModes: ['full_refresh'],
  });
  protected readonly catalog = new Catalog([this.documents]);

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
    for (const row of this.rows) yield { stream: 'documents', data: row };
  }
}

// A pipeline that copies the documents and cuts the title and body of each
// into the computed dataset chunks.
function documentChunks(directory: string, chunking: () => Chunking) {
  const source = new Documents();
  const path = join(directory, 'data.sqlite');
  const destination = new SQLiteDestination({ path });
  const target = destination.table('documents');
  const run = () =>
    new Pipeline({
      clock: globalThis,
      history: new SQLiteSyncHistory(),
      connections: [
        new Connection({
          name: 'documents',
          source,
          destination,
          steps: [new Copy(source.documents, target)],
        }),
      ],
      derived: [
        new ComputedDataset({
          into: destination,
          name: 'chunks',
          description: 'The chunks of each document.',
          from: [target],
          compute: chunking(),
        }),
      ],
    }).run();
  const rows = (sql: string) => {
    using database = open(path, { readOnly: true });
    return database
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  };
  return { source, run, rows };
}

const sizes = (maxTokens: number, overlapTokens: number) =>
  new Chunking({
    tokenizer: cl100k,
    maxTokens,
    overlapTokens,
    key: 'id',
    fields: ['body'],
  });

async function chunksOf(rule: Chunking, text: string) {
  const [result] = await rule.compute([text]);
  if (result === undefined || !('parts' in result))
    assert.fail(`the text gave no parts: ${JSON.stringify(result)}`);
  return result.parts;
}

// The offsets in code points where a grapheme of text starts or ends.
function graphemeEdges(text: string): Set<number> {
  const edges = new Set([0]);
  let point = 0;
  for (const { segment } of new Intl.Segmenter('und', {
    granularity: 'grapheme',
  }).segment(text)) {
    point += [...segment].length;
    edges.add(point);
  }
  return edges;
}

// A long text in several scripts: English with an abbreviation and a number,
// accents written as combining marks, Arabic, Japanese with no spaces, emoji
// joined with ZWJ and skin tones, a run of family emoji, one word of accents
// written as combining marks that is longer than a chunk, and a run of
// Japanese with no boundary but the word.
const sentences = [
  'Dr. Smith moved 3.5 tonnes of grain to the north barn before noon.',
  'Cafe\u0301 owners in the old town re\u0301sume\u0301 their work at dawn.',
  'يعمل الفريق على تحسين النظام كل يوم من أجل المستخدمين.',
  '東京の会議は午後三時に始まり、参加者は資料を読みながら議論を続けた。',
  'The family 👩‍👩‍👧‍👦 waved 👋🏽 at the boat 🛶 as it left the harbour.',
];
const longText = [
  '  ',
  ...Array.from({ length: 12 }, (_, paragraph) =>
    Array.from(
      { length: 4 },
      (_, sentence) => sentences[(paragraph + sentence) % sentences.length],
    ).join(' '),
  ),
  '👩‍👩‍👧‍👦'.repeat(6),
  // One word of 120 tokens, cut at its graphemes.
  'e\u0301'.repeat(60),
  '東京大阪名古屋札幌福岡神戸京都横浜仙台広島'.repeat(3),
  '',
].join('\n\n');

test('the constructor refuses a maxTokens below 1 or not an integer, an overlapTokens below 0 or not an integer, and an overlapTokens above half of maxTokens, naming the value', () => {
  assert.throws(
    () => sizes(0, 0),
    new RangeError('maxTokens is an integer of 1 or more, not 0.'),
  );
  assert.throws(
    () => sizes(1.5, 0),
    new RangeError('maxTokens is an integer of 1 or more, not 1.5.'),
  );
  assert.throws(
    () => sizes(800, -1),
    new RangeError('overlapTokens is an integer of 0 or more, not -1.'),
  );
  assert.throws(
    () => sizes(800, 0.5),
    new RangeError('overlapTokens is an integer of 0 or more, not 0.5.'),
  );
  assert.throws(
    () => sizes(800, 401),
    new RangeError('overlapTokens is at most half of maxTokens 800, not 401.'),
  );
  assert.throws(
    () => sizes(1, 1),
    new RangeError('overlapTokens is at most half of maxTokens 1, not 1.'),
  );
  assert.doesNotThrow(() => sizes(800, 400));
  assert.doesNotThrow(() => sizes(1, 0));
});

test('the rule identity names the package version, the vocabulary and the two sizes, so a change of any of them cuts each text again', async () => {
  assert.equal(
    await sizes(800, 400).identity(),
    `@eltjs/chunking@${manifest.version} cl100k_base 800/400`,
  );
  assert.equal(
    await sizes(800, 200).identity(),
    `@eltjs/chunking@${manifest.version} cl100k_base 800/200`,
  );
  assert.equal(
    await new Chunking({
      tokenizer: { name: 'o200k_base', count: countTokens },
      maxTokens: 512,
      overlapTokens: 0,
      key: 'id',
      fields: ['body'],
    }).identity(),
    `@eltjs/chunking@${manifest.version} o200k_base 512/0`,
  );
});

test('a text that fits is one chunk with no white space at its start or end, with its count of tokens and its offsets in code points', async () => {
  assert.deepEqual(await chunksOf(sizes(800, 400), '\n  😀 Hello world.  \n'), [
    {
      text: '😀 Hello world.',
      tokens: countTokens('😀 Hello world.'),
      start: 3,
      end: 17,
    },
  ]);
});

test('a longer text is cut at the largest boundary that fits: a paragraph that fits stays whole, then whole lines, then whole sentences', async () => {
  const [a1, b1, b2, d1, d2, d3, e1, e2, e3] = [
    'The red fox runs over the green hill.',
    'The tan dog sleeps under the oak tree.',
    'A boat sails on the calm blue sea.',
    'A bird sings in the tall pine tree.',
    'A child reads a short book by the fire.',
    'A cat waits by the warm stove for milk.',
    'The old man walks to the market slowly.',
    'The young girl paints the garden gate.',
    'The baker sells fresh bread every morning.',
  ];
  // Any two sentences fit, so a smaller boundary would join a sentence to
  // the chunk before it; no three fit.
  const maxTokens = Math.max(
    ...[
      `${a1}\n\n${b1}`,
      `${b1}\n${b2}`,
      `${d1}\n${d2}`,
      `${d2} ${d3}`,
      `${e1} ${e2}`,
    ].map((text) => countTokens(text)),
  );
  assert.ok(
    [
      `${a1}\n\n${b1}\n${b2}`,
      `${b1}\n${b2}\n\n${d1}`,
      `${d1}\n${d2} ${d3}`,
      `${d2} ${d3}\n\n${e1}`,
      `${e1} ${e2} ${e3}`,
    ].every((text) => countTokens(text) > maxTokens),
    'the sizes of the text are as the test needs',
  );

  const chunks = await chunksOf(
    sizes(maxTokens, 0),
    [a1, `${b1}\n${b2}`, `${d1}\n${d2} ${d3}`, `${e1} ${e2} ${e3}`].join(
      '\n\n',
    ),
  );

  assert.deepEqual(
    chunks.map(({ text }) => text),
    [a1, `${b1}\n${b2}`, d1, `${d2} ${d3}`, `${e1} ${e2}`, e3],
  );
});

test('each chunk after the first starts with the last whole pieces of the chunk before it that count at most overlapTokens tokens together', async () => {
  const [ship, birds, rain, farmer, wind] = [
    'The long grey ship sailed slowly past the old stone harbour wall.',
    'Birds sang.',
    'Rain fell.',
    'A tired farmer walked his three brown cows down the muddy lane.',
    'Wind blew.',
  ];
  const maxTokens = countTokens(`${birds} ${rain} ${farmer}`);
  const overlapTokens = countTokens(`${birds} ${rain}`);
  assert.ok(
    overlapTokens <= maxTokens / 2 &&
      countTokens(`${ship} ${birds} ${rain}`) <= maxTokens &&
      countTokens(`${ship} ${birds} ${rain} ${farmer}`) > maxTokens &&
      countTokens(`${birds} ${rain} ${farmer} ${wind}`) > maxTokens &&
      countTokens(farmer) > overlapTokens,
    'the sizes of the text are as the test needs',
  );

  const chunks = await chunksOf(
    sizes(maxTokens, overlapTokens),
    [ship, birds, rain, farmer, wind].join(' '),
  );

  // Two short sentences make the overlap of the second chunk; the farmer's
  // sentence alone counts more than overlapTokens, so the third has none.
  assert.deepEqual(
    chunks.map(({ text }) => text),
    [`${ship} ${birds} ${rain}`, `${birds} ${rain} ${farmer}`, wind],
  );
});

test('in a long text in several scripts, no chunk counts more than maxTokens, a cut is never inside a grapheme, the offsets slice the text by code points, the overlap counts at most overlapTokens, each chunk starts after the one before, no text is lost, and the same text gives the same chunks', async () => {
  const maxTokens = 40;
  const overlapTokens = 20;
  const points = [...longText];
  const edges = graphemeEdges(longText);

  const chunks = await chunksOf(sizes(maxTokens, overlapTokens), longText);

  assert.ok(chunks.length > 10, `${chunks.length} chunks`);
  for (const { text, tokens, start, end } of chunks) {
    assert.equal(tokens, countTokens(text ?? ''));
    assert.ok((tokens ?? Infinity) <= maxTokens, `${tokens} tokens: ${text}`);
    assert.equal(points.slice(start, end).join(''), text);
    assert.equal(text, text?.trim());
    assert.ok(edges.has(start ?? -1) && edges.has(end ?? -1), `${text}`);
  }
  const [first] = chunks;
  assert.equal(first?.start, points.length - [...longText.trimStart()].length);
  assert.equal(chunks.at(-1)?.end, [...longText.trimEnd()].length);
  let overlaps = 0;
  for (const [index, next] of chunks.slice(1).entries()) {
    const previous = chunks[index];
    assert.ok((next.start ?? 0) > (previous?.start ?? Infinity));
    const shared = points.slice(next.start, previous?.end).join('');
    if ((next.start ?? 0) < (previous?.end ?? 0)) {
      overlaps += 1;
      assert.ok(
        countTokens(shared.trim()) <= overlapTokens,
        `the overlap ${JSON.stringify(shared)} counts more than ${overlapTokens}`,
      );
    } else {
      assert.equal(
        points.slice(previous?.end, next.start).join('').trim(),
        '',
        'text between two chunks is lost',
      );
    }
  }
  assert.ok(overlaps > chunks.length / 2, `${overlaps} overlaps`);
  assert.deepEqual(
    await chunksOf(sizes(maxTokens, overlapTokens), longText),
    chunks,
  );
});

test('a grapheme that counts more than maxTokens stores its document failed with the offset of the grapheme, and the other documents of the call get their chunks; a document with no text gets none', async () => {
  await using scratch = await new TemporaryFiles().directory('chunking-');
  const { source, run, rows } = documentChunks(
    scratch.path,
    () =>
      new Chunking({
        tokenizer: cl100k,
        maxTokens: 4,
        overlapTokens: 0,
        key: 'id',
        fields: ['title', 'body'],
      }),
  );
  source.rows = [
    { id: 'family', title: 'Hi', body: 'a 😀 👩‍👩‍👧‍👦 b' },
    { id: 'fine', title: null, body: 'One two.' },
    { id: 'blank', title: null, body: '  ' },
  ];

  await run();

  assert.deepEqual(
    {
      outputs: rows('SELECT id, status, error FROM chunks ORDER BY id'),
      parts: rows(
        'SELECT id, seq, text, tokens, start, "end" FROM chunks_parts ORDER BY id, seq',
      ),
    },
    {
      outputs: [
        {
          id: 'family',
          status: 'failed',
          error: `The grapheme at offset 7 counts ${countTokens('👩‍👩‍👧‍👦')} tokens, more than maxTokens 4.`,
        },
        { id: 'fine', status: 'computed', error: null },
      ],
      parts: [
        {
          id: 'fine',
          seq: 0,
          text: 'One two.',
          tokens: countTokens('One two.'),
          start: 0,
          end: 8,
        },
      ],
    },
  );
});

test('a tokenizer that throws stores each document of the call failed with its message', async () => {
  await using scratch = await new TemporaryFiles().directory('chunking-');
  const { source, run, rows } = documentChunks(
    scratch.path,
    () =>
      new Chunking({
        // A real tokenizer cannot be made to throw.
        tokenizer: {
          name: 'cl100k_base',
          count: (text) => {
            if (text.includes('boom')) throw new Error('the tokenizer broke');
            return countTokens(text);
          },
        },
        maxTokens: 800,
        overlapTokens: 0,
        key: 'id',
        fields: ['body'],
      }),
  );
  source.rows = [
    { id: 'a', title: null, body: 'A calm text.' },
    { id: 'b', title: null, body: 'A text that goes boom.' },
  ];

  await run();

  assert.deepEqual(
    {
      outputs: rows('SELECT id, status, error FROM chunks ORDER BY id'),
      parts: rows('SELECT id FROM chunks_parts'),
    },
    {
      outputs: [
        { id: 'a', status: 'failed', error: 'the tokenizer broke' },
        { id: 'b', status: 'failed', error: 'the tokenizer broke' },
      ],
      parts: [],
    },
  );
});

test('an edit near the start of a long document gives the first chunk a new part hash, and the later chunks keep their text and part hash while their offsets move', async () => {
  await using scratch = await new TemporaryFiles().directory('chunking-');
  const { source, run, rows } = documentChunks(
    scratch.path,
    () =>
      new Chunking({
        tokenizer: cl100k,
        maxTokens: 40,
        overlapTokens: 20,
        key: 'id',
        fields: ['title', 'body'],
      }),
  );
  // One token each, so the edit moves no cut.
  assert.deepEqual([countTokens('Report'), countTokens('Summary')], [1, 1]);
  const moved = 'Summary'.length - 'Report'.length;
  const parts =
    'SELECT seq, part_hash, text, start, "end" FROM chunks_parts ORDER BY seq';
  source.rows = [{ id: 'doc', title: 'Report', body: longText }];
  await run();
  const before = rows(parts);

  source.rows = [{ id: 'doc', title: 'Summary', body: longText }];
  await run();
  const after = rows(parts);

  assert.ok(before.length > 10, `${before.length} chunks`);
  assert.equal(after.length, before.length);
  assert.notEqual(after[0]?.part_hash, before[0]?.part_hash);
  assert.deepEqual(
    after.slice(1),
    before.slice(1).map(({ start, end, ...part }) => ({
      ...part,
      start: Number(start) + moved,
      end: Number(end) + moved,
    })),
  );
  const input = [...`Summary\n${longText}`];
  for (const { text, start, end } of after)
    assert.equal(input.slice(Number(start), Number(end)).join(''), text);
  assert.deepEqual(rows('SELECT rule, status FROM chunks'), [
    {
      rule: `@eltjs/chunking@${manifest.version} cl100k_base 40/20`,
      status: 'computed',
    },
  ]);
});
