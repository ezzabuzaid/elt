import type { Vector } from '@zukhruf/vectors';

// One row a copy loaded, as its destination reads it back, by column.
export type LoadedRow = Readonly<Record<string, unknown>>;

// What a rule made of one input: a value, nothing to store (a photo with no
// text), its own failure, which the output row records, or the input was gone
// before the rule read it (a stop ended the refresh), so no row is written.
export type RuleResult<Output> =
  | { readonly value: Output }
  | { readonly empty: true }
  | { readonly error: string }
  | { readonly gone: true };

// A column a rule adds to its output rows. Each destination keeps each kind
// in its own form, such as a vector as the bytes of @zukhruf/vectors/sqlite
// in SQLite.
export type RuleColumn =
  | { readonly type: 'text'; readonly description: string }
  | { readonly type: 'blob'; readonly description: string }
  | {
      readonly type: 'vector';
      readonly dimensions: number;
      readonly description: string;
    }
  | { readonly type: 'integer'; readonly description: string };

// The columns a rule adds to its output rows, by name.
export type RuleColumns = Readonly<Record<string, RuleColumn>>;

// The value of each kind of column: an integer is a safe integer, and a
// vector has the dimensions of its column.
type ColumnValue = {
  readonly text: string;
  readonly blob: Uint8Array;
  readonly vector: Vector;
  readonly integer: number;
};

// The values of one output row, each of the type of its column's kind. A
// column with no value is NULL.
export type RuleValues<Columns extends RuleColumns> = {
  readonly [Name in keyof Columns]?: ColumnValue[Columns[Name]['type']];
};

// How a computed dataset turns each input into its stored output, such as a
// file's text or a listing's vector (a Strategy). Its identity names what made
// an output, the parser's format or the model, so an output made otherwise
// is made again, as pgai's vectorizer re-embeds rows after a model change.
export abstract class Rule<Input, Columns extends RuleColumns> {
  // The output's key column: the input's own key, such as a file's ref.
  abstract readonly key: {
    readonly name: string;
    readonly description: string;
  };
  // The columns the rule adds to each output row.
  abstract readonly output: Columns;
  // How many inputs one compute call takes, such as the texts of one model
  // call, and how many calls run at once, such as files parsed side by side.
  // The rows of a call commit as soon as it settles, so a slow call holds
  // only its own place, never the calls after it.
  abstract readonly batch: number;
  abstract readonly concurrency: number;

  // The key and input of one loaded row, or null when the row has none, such
  // as an attachment row with no stored file.
  abstract read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: Input } | null;

  // What would make the output of input. null means the rule does not handle
  // the input: an output made before stays, and a missing one is stored empty.
  abstract identity(input: Input): Promise<string | null>;

  // One result for each input, in order.
  abstract compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<RuleValues<Columns>>[]>;
}
