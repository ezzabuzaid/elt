// One row a copy loaded, as its destination reads it back, by column.
export type LoadedRow = Readonly<Record<string, unknown>>;

// What a rule made of one input: a value, nothing to store (a photo with no
// text), its own failure, which the output row records, or the input was gone
// before the rule read it (a file a commit removed), so no row is written.
export type RuleResult<Output> =
  | { readonly value: Output }
  | { readonly empty: true }
  | { readonly error: string }
  | { readonly gone: true };

// A column a rule adds to its output rows, as SQLite stores it.
export type RuleColumn = {
  readonly description: string;
  readonly type: 'text' | 'blob';
};

// How a computed dataset turns each input into its stored output, such as a
// file's text or a listing's vector (a Strategy). Its identity names what made
// an output, the parser's format or the model, so an output made otherwise
// is made again, as pgai's vectorizer re-embeds rows after a model change.
export abstract class Rule<Input, Output> {
  // The output's key column: the input's own key, such as a file's ref.
  abstract readonly key: {
    readonly name: string;
    readonly description: string;
  };
  // The columns the rule adds to each output row.
  abstract readonly output: Readonly<Record<string, RuleColumn>>;
  // How many inputs one compute call takes, such as files parsed at once.
  abstract readonly batch: number;

  // The key and input of one loaded row, or null when the row has none, such
  // as an attachment row with no stored file.
  abstract read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: Input } | null;

  // What would make the output of input. null means the rule does not handle
  // the input: an output made before stays, and a missing one is stored empty.
  abstract identity(input: Input): Promise<string | null>;

  // One result for each input, in order. Columns come from output.
  abstract compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<readonly RuleResult<Readonly<Record<string, Output>>>[]>;
}
