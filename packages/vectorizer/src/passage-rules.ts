import { Chunking } from '@eltjs/chunking';
import {
  type LoadedRow,
  type RuleColumns,
  type RuleValues,
  TableRule,
  type TableRuleResult,
  rowText,
} from '@eltjs/elt';

import manifest from '../package.json' with { type: 'json' };
import { type ChunkingOptions, type SourceKey, keyColumns } from './options.ts';

// The key column of the chunks of a vectorizer, which Passage.source reads.
const source = {
  name: 'source',
  description:
    'The key of the source row that the passage is cut from: the value of its key column, or the JSON array of the values of its key columns.',
};

// Passage.source of a loaded row, or null when the row has no key: the
// plain value of a key of one column, or the JSON array of the values of a
// key of several columns, as the destination reads them back (ADR 0001).
export function sourceOf(key: SourceKey): (row: LoadedRow) => string | null {
  if (typeof key === 'string')
    return (row) => {
      const value = row[key];
      return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
    };
  const columns = keyColumns(key);
  return (row) => {
    const values = columns.map((column) => row[column]);
    return values.some((value) => value === null || value === undefined)
      ? null
      : JSON.stringify(values);
  };
}

// The rule that cuts the text of the fields of each source row: the chunks of
// @eltjs/chunking, or one passage for each row.
export function passageRule({
  key,
  fields,
  chunking,
}: {
  readonly key: SourceKey;
  readonly fields: readonly [string, ...string[]];
  readonly chunking: ChunkingOptions;
}): PassageChunks | OnePart {
  return chunking === 'none'
    ? new OnePart({ key, fields })
    : new PassageChunks({ key, fields, chunking });
}

// The chunks of Chunking, keyed by the source of each row (a Decorator):
// Chunking cuts and names what made the chunks; the vectorizer reads the key,
// which may span several columns.
export class PassageChunks extends TableRule<
  string,
  Chunking['output'],
  Chunking['place']
> {
  override readonly key = source;
  override readonly output: Chunking['output'];
  override readonly place: Chunking['place'];
  override readonly batch: number;
  override readonly concurrency: number;
  readonly #chunking: Chunking;
  readonly #source: (row: LoadedRow) => string | null;
  readonly #fields: readonly string[];

  constructor({
    key,
    fields,
    chunking,
  }: {
    key: SourceKey;
    fields: readonly [string, ...string[]];
    chunking: Exclude<ChunkingOptions, 'none'>;
  }) {
    super();
    this.#chunking = new Chunking({ ...chunking, key: source.name, fields });
    this.output = this.#chunking.output;
    this.place = this.#chunking.place;
    this.batch = this.#chunking.batch;
    this.concurrency = this.#chunking.concurrency;
    this.#source = sourceOf(key);
    this.#fields = Object.freeze([...fields]);
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: string } | null {
    return readPassage(row, this.#source, this.#fields);
  }

  override identity(): Promise<string> {
    return this.#chunking.identity();
  }

  override compute(
    texts: readonly string[],
  ): Promise<
    readonly TableRuleResult<
      RuleValues<Chunking['output']> & RuleValues<Chunking['place']>
    >[]
  > {
    return this.#chunking.compute(texts);
  }
}

const whole = {
  text: {
    type: 'text',
    description: 'The text of the passage: the whole text of its row.',
  },
} as const satisfies RuleColumns;

const span = {
  start: {
    type: 'integer',
    description: 'The offset of the first code point of the passage: 0.',
  },
  end: {
    type: 'integer',
    description:
      'The offset after the last code point of the passage: the count of code points of the text.',
  },
} as const satisfies RuleColumns;

// One passage for each row, its whole text, so the passages of every chunking
// are rows of one parts table and one SQL reads them (pgai chunking_none).
// Offsets count code points, as ContextWindow of @zukhruf/retrieval merges
// by them.
export class OnePart extends TableRule<string, typeof whole, typeof span> {
  override readonly key = source;
  override readonly output = whole;
  override readonly place = span;
  // Taking the text is synchronous work, as cutting it is.
  override readonly batch = 32;
  override readonly concurrency = 1;
  readonly #source: (row: LoadedRow) => string | null;
  readonly #fields: readonly string[];

  constructor({
    key,
    fields,
  }: {
    key: SourceKey;
    fields: readonly [string, ...string[]];
  }) {
    super();
    this.#source = sourceOf(key);
    this.#fields = Object.freeze([...fields]);
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: string } | null {
    return readPassage(row, this.#source, this.#fields);
  }

  // The code makes every passage, so its version names them (elt ADR 0005).
  override async identity(): Promise<string> {
    return `${manifest.name}@${manifest.version} none`;
  }

  override async compute(
    texts: readonly string[],
  ): Promise<
    readonly TableRuleResult<
      RuleValues<typeof whole> & RuleValues<typeof span>
    >[]
  > {
    return texts.map((text) => ({
      parts: [{ text, start: 0, end: [...text].length }],
    }));
  }
}

function readPassage(
  row: LoadedRow,
  source: (row: LoadedRow) => string | null,
  fields: readonly string[],
): { readonly key: string; readonly input: string } | null {
  const key = source(row);
  if (key === null) return null;
  const text = rowText(row, fields);
  return text === null ? null : { key, input: text };
}
