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

// The input of a passage rule: the text of a source row, or, when the ids of
// the passages have a most length, the text with the source that each id
// starts with, so the rule can fail the input whose ids are too long.
type PassageInput = string | { readonly source: string; readonly text: string };

// The rule that cuts the text of the fields of each source row: the chunks of
// @eltjs/chunking, or one passage for each row. maxIdLength: the most UTF-16
// units of a passage id <source>:<seq> that the destination holds, such as
// 450 on SQL Server; none when absent.
export function passageRule({
  key,
  fields,
  chunking,
  maxIdLength,
}: {
  readonly key: SourceKey;
  readonly fields: readonly [string, ...string[]];
  readonly chunking: ChunkingOptions;
  readonly maxIdLength?: number;
}): PassageChunks | OnePart {
  return chunking === 'none'
    ? new OnePart({ key, fields, maxIdLength })
    : new PassageChunks({ key, fields, chunking, maxIdLength });
}

// The chunks of Chunking, keyed by the source of each row (a Decorator):
// Chunking cuts and names what made the chunks; the vectorizer reads the key,
// which may span several columns.
export class PassageChunks extends TableRule<
  PassageInput,
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
  readonly #maxIdLength: number | undefined;

  constructor({
    key,
    fields,
    chunking,
    maxIdLength,
  }: {
    key: SourceKey;
    fields: readonly [string, ...string[]];
    chunking: Exclude<ChunkingOptions, 'none'>;
    maxIdLength: number | undefined;
  }) {
    super();
    this.#chunking = new Chunking({ ...chunking, key: source.name, fields });
    this.output = this.#chunking.output;
    this.place = this.#chunking.place;
    this.batch = this.#chunking.batch;
    this.concurrency = this.#chunking.concurrency;
    this.#source = sourceOf(key);
    this.#fields = Object.freeze([...fields]);
    this.#maxIdLength = maxIdLength;
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: PassageInput } | null {
    return readPassage(row, this.#source, this.#fields, this.#maxIdLength);
  }

  override identity(): Promise<string> {
    return this.#chunking.identity();
  }

  override async compute(
    inputs: readonly PassageInput[],
  ): Promise<
    readonly TableRuleResult<
      RuleValues<Chunking['output']> & RuleValues<Chunking['place']>
    >[]
  > {
    const results = await this.#chunking.compute(inputs.map(textOf));
    return results.map((result, index) =>
      fitIds(inputs[index], result, this.#maxIdLength),
    );
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
export class OnePart extends TableRule<
  PassageInput,
  typeof whole,
  typeof span
> {
  override readonly key = source;
  override readonly output = whole;
  override readonly place = span;
  // Taking the text is synchronous work, as cutting it is.
  override readonly batch = 32;
  override readonly concurrency = 1;
  readonly #source: (row: LoadedRow) => string | null;
  readonly #fields: readonly string[];
  readonly #maxIdLength: number | undefined;

  constructor({
    key,
    fields,
    maxIdLength,
  }: {
    key: SourceKey;
    fields: readonly [string, ...string[]];
    maxIdLength: number | undefined;
  }) {
    super();
    this.#source = sourceOf(key);
    this.#fields = Object.freeze([...fields]);
    this.#maxIdLength = maxIdLength;
    Object.freeze(this);
  }

  override read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: PassageInput } | null {
    return readPassage(row, this.#source, this.#fields, this.#maxIdLength);
  }

  // The code makes every passage, so its version names them (elt ADR 0005).
  override async identity(): Promise<string> {
    return `${manifest.name}@${manifest.version} none`;
  }

  override async compute(
    inputs: readonly PassageInput[],
  ): Promise<
    readonly TableRuleResult<
      RuleValues<typeof whole> & RuleValues<typeof span>
    >[]
  > {
    return inputs.map((input) => {
      const text = textOf(input);
      return fitIds(
        input,
        { parts: [{ text, start: 0, end: [...text].length }] },
        this.#maxIdLength,
      );
    });
  }
}

// The source and the text of a row as the input of a passage rule: the text
// alone when the ids have no most length, so the input hash of a host with no
// limit stays the hash of its text.
function readPassage(
  row: LoadedRow,
  source: (row: LoadedRow) => string | null,
  fields: readonly string[],
  maxIdLength: number | undefined,
): { readonly key: string; readonly input: PassageInput } | null {
  const key = source(row);
  if (key === null) return null;
  const text = rowText(row, fields);
  if (text === null) return null;
  return {
    key,
    input: maxIdLength === undefined ? text : { source: key, text },
  };
}

const textOf = (input: PassageInput | undefined) =>
  typeof input === 'object' ? input.text : String(input);

// The result of an input, or a rule failure of the input when the id of its
// last passage, <source>:<seq>, has more UTF-16 units than maxIdLength, the
// unit that NVARCHAR(n) of SQL Server counts. The other inputs go on, and no
// part of the input reaches the keyword index.
function fitIds<Part>(
  input: PassageInput | undefined,
  result: TableRuleResult<Part>,
  maxIdLength: number | undefined,
): TableRuleResult<Part> {
  if (
    maxIdLength === undefined ||
    typeof input !== 'object' ||
    !('parts' in result)
  )
    return result;
  const length = `${input.source}:${result.parts.length - 1}`.length;
  return length > maxIdLength
    ? {
        error: `The passage ids of this source row have up to ${length} characters, more than ${maxIdLength}, the most that the passage ids of the destination hold: give the vectorizer a shorter source key.`,
      }
    : result;
}
