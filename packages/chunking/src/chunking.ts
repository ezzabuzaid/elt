import {
  type LoadedRow,
  type RuleColumns,
  type RuleValues,
  TableRule,
  type TableRuleResult,
  errorMessage,
} from '@eltjs/elt';

import manifest from '../package.json' with { type: 'json' };

// What counts tokens as the embedding model counts them (ADR 0002): for
// OpenAI's text-embedding-3-small, cl100k_base and countTokens of
// gpt-tokenizer.
export type Tokenizer = {
  // The name of the vocabulary, such as cl100k_base. It is part of the rule
  // identity.
  readonly name: string;
  // How many tokens the model counts in text.
  count(text: string): number;
};

const content = {
  text: {
    type: 'text',
    description:
      'The text of the chunk: a slice of the input, with no white space at its start or end.',
  },
  tokens: {
    type: 'integer',
    description: 'How many tokens the text of the chunk counts.',
  },
} as const satisfies RuleColumns;

const place = {
  start: {
    type: 'integer',
    description:
      'The offset of the first code point of the chunk in the input, from 0.',
  },
  end: {
    type: 'integer',
    description:
      'The offset after the last code point of the chunk in the input.',
  },
} as const satisfies RuleColumns;

type Chunk = RuleValues<typeof content> & RuleValues<typeof place>;

// A run of a text, in UTF-16 units of the input, end exclusive.
type Piece = { readonly from: number; readonly to: number };

// The ends of the pieces of a text at each boundary, from the largest: a
// paragraph (two or more line breaks), a line, a sentence, a word and a
// grapheme (ADR 0003). Each piece keeps its separator, so the pieces join back
// into the text. Intl.Segmenter applies Unicode text segmentation (UAX #29);
// the rule asks for the root locale.
const boundaries: readonly ((text: string) => Iterable<number>)[] = [
  (text) =>
    Array.from(
      text.matchAll(/\n\s*\n/g),
      (match) => match.index + match[0].length,
    ),
  (text) => Array.from(text.matchAll(/\n/g), (match) => match.index + 1),
  ...(['sentence', 'word', 'grapheme'] as const).map((granularity) => {
    const segmenter = new Intl.Segmenter('und', { granularity });
    return (text: string) =>
      Array.from(
        segmenter.segment(text),
        ({ index, segment }) => index + segment.length,
      );
  }),
];

// One grapheme that counts more tokens than a chunk may hold, at its place in
// UTF-16 units of the input.
type Unfit = { readonly grapheme: number; readonly tokens: number };

// The chunks of each loaded row's text, each counting at most maxTokens
// tokens of the embedding model's tokenizer, so the Embedding rule can make
// one vector for each chunk (ADR 0001). A chunk ends at the largest boundary
// that fits, and starts with the last whole pieces of the chunk before it,
// up to overlapTokens tokens.
export class Chunking extends TableRule<string, typeof content, typeof place> {
  override readonly key: {
    readonly name: string;
    readonly description: string;
  };
  override readonly output = content;
  override readonly place = place;
  // Cutting is synchronous work, so calls side by side gain nothing, and a
  // batch keeps the commits few.
  override readonly batch = 32;
  override readonly concurrency = 1;
  readonly #tokenizer: Tokenizer;
  readonly #maxTokens: number;
  readonly #overlapTokens: number;
  readonly #fields: readonly string[];

  // tokenizer: the tokenizer of the embedding model. maxTokens: the most
  // tokens of a chunk. overlapTokens: the most tokens a chunk repeats of the
  // chunk before it, at most half of maxTokens (ADR 0004). key: the column
  // that identifies a row. fields: the columns whose text the rule cuts,
  // joined by line breaks; a row with none has no chunks.
  constructor({
    tokenizer,
    maxTokens,
    overlapTokens,
    key,
    fields,
  }: {
    tokenizer: Tokenizer;
    maxTokens: number;
    overlapTokens: number;
    key: string;
    fields: readonly string[];
  }) {
    super();
    if (!Number.isInteger(maxTokens) || maxTokens < 1)
      throw new RangeError(
        `maxTokens is an integer of 1 or more, not ${maxTokens}.`,
      );
    if (!Number.isInteger(overlapTokens) || overlapTokens < 0)
      throw new RangeError(
        `overlapTokens is an integer of 0 or more, not ${overlapTokens}.`,
      );
    if (overlapTokens > maxTokens / 2)
      throw new RangeError(
        `overlapTokens is at most half of maxTokens ${maxTokens}, not ${overlapTokens}.`,
      );
    this.#tokenizer = tokenizer;
    this.#maxTokens = maxTokens;
    this.#overlapTokens = overlapTokens;
    this.key = {
      name: key,
      description: `The ${key} of the row the chunks are cut from.`,
    };
    this.#fields = Object.freeze([...fields]);
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: string } | null {
    const key = row[this.key.name];
    if (typeof key !== 'string' && typeof key !== 'number') return null;
    const text = this.#fields
      .map((field) => row[field])
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .join('\n');
    return text === '' ? null : { key: String(key), input: text };
  }

  // The code that cuts, the vocabulary and the sizes make every chunk, so
  // they name them all (ADR 0005).
  override async identity(): Promise<string> {
    return `${manifest.name}@${manifest.version} ${this.#tokenizer.name} ${this.#maxTokens}/${this.#overlapTokens}`;
  }

  override async compute(
    texts: readonly string[],
  ): Promise<readonly TableRuleResult<Chunk>[]> {
    try {
      return texts.map((text) => this.#cut(text));
    } catch (failure) {
      // A tokenizer that throws says nothing about one text: each input of
      // the call fails, and the next pass tries again.
      const error = errorMessage(failure);
      return texts.map(() => ({ error }));
    }
  }

  #cut(text: string): TableRuleResult<Chunk> {
    const pieces = this.#split(text, 0, text.length, 0);
    if ('grapheme' in pieces)
      return {
        error: `The grapheme at offset ${[...text.slice(0, pieces.grapheme)].length} counts ${pieces.tokens} tokens, more than maxTokens ${this.#maxTokens}.`,
      };
    const [first, ...rest] = this.#pack(text, pieces);
    return first === undefined ? { empty: true } : { parts: [first, ...rest] };
  }

  // The pieces of the text between from and to that each fit, cut at the largest
  // boundary that makes them fit. A piece that fits at one boundary is not cut
  // at a smaller one.
  #split(
    text: string,
    from: number,
    to: number,
    level: number,
  ): Piece[] | Unfit {
    const tokens = this.#count(text.slice(from, to));
    if (tokens <= this.#maxTokens) return [{ from, to }];
    const ends = boundaries[level];
    // Past the grapheme boundary, the piece is one grapheme.
    if (ends === undefined) return { grapheme: from, tokens };
    const pieces: Piece[] = [];
    let start = from;
    for (const end of [...ends(text.slice(from, to)), to - from]) {
      if (from + end <= start) continue;
      const split = this.#split(text, start, from + end, level + 1);
      if ('grapheme' in split) return split;
      pieces.push(...split);
      start = from + end;
    }
    return pieces;
  }

  // The chunks of the pieces in order: a piece joins the chunk while the chunk
  // fits. The next chunk starts with the last whole pieces of the chunk, up to
  // overlapTokens, that start after its text starts, so each chunk starts
  // after the start of the chunk before it.
  #pack(text: string, pieces: readonly Piece[]): Chunk[] {
    const chunks: Chunk[] = [];
    const offsets = new Offsets(text);
    // The starts of the pieces in the chunk being packed.
    let starts: number[] = [];
    for (const { from, to } of pieces) {
      const [start] = starts;
      if (start !== undefined && !this.#fits(text.slice(start, to))) {
        const visible = start + leadingSpace(text.slice(start, from));
        chunks.push(...this.#chunk(text, visible, from, offsets));
        starts = this.#overlap(
          text,
          starts.filter((piece) => piece > visible),
          from,
          to,
        );
      }
      starts.push(from);
    }
    const [start] = starts;
    if (start !== undefined) {
      const visible = start + leadingSpace(text.slice(start));
      chunks.push(...this.#chunk(text, visible, text.length, offsets));
    }
    return chunks;
  }

  // The last of the starts whose text up to from counts at most overlapTokens,
  // and whose text with the next piece, up to to, fits.
  #overlap(
    text: string,
    starts: readonly number[],
    from: number,
    to: number,
  ): number[] {
    const kept: number[] = [];
    for (const start of starts.toReversed()) {
      if (
        this.#count(text.slice(start, from)) > this.#overlapTokens ||
        !this.#fits(text.slice(start, to))
      )
        break;
      kept.unshift(start);
    }
    return kept;
  }

  // The chunk of text from start, its first code point that is not white
  // space, to end, with no white space at its end; none when it holds only
  // white space.
  #chunk(text: string, start: number, end: number, offsets: Offsets): Chunk[] {
    const trimmed = text.slice(start, end).trimEnd();
    if (trimmed === '') return [];
    const point = offsets.at(start);
    return [
      {
        text: trimmed,
        tokens: this.#tokenizer.count(trimmed),
        start: point,
        end: point + [...trimmed].length,
      },
    ];
  }

  #fits(text: string): boolean {
    return this.#count(text) <= this.#maxTokens;
  }

  // The tokens of a text as its chunk holds it, with no white space at its
  // start or end.
  #count(text: string): number {
    return this.#tokenizer.count(text.trim());
  }
}

// How many UTF-16 units of white space a text starts with.
function leadingSpace(text: string): number {
  return text.length - text.trimStart().length;
}

// The offset in code points of a place in UTF-16 units of a text, for places
// asked in order, so the text is read once.
class Offsets {
  readonly #text: string;
  #unit = 0;
  #point = 0;

  constructor(text: string) {
    this.#text = text;
  }

  at(unit: number): number {
    this.#point += [...this.#text.slice(this.#unit, unit)].length;
    this.#unit = unit;
    return this.#point;
  }
}
