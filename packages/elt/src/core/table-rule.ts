import type { LoadedRow, RuleColumns, RuleValues } from './rule.ts';

// What a table rule made of one input: its parts in order, nothing to store,
// its own failure, or the input was gone before the rule read it. An input
// with no parts is empty, so a list of parts always holds one or more.
export type TableRuleResult<Part> =
  | { readonly parts: readonly [Part, ...Part[]] }
  | { readonly empty: true }
  | { readonly error: string }
  | { readonly gone: true };

// How a computed dataset turns each input into many parts, such as the chunks
// of a text (a table function, as Postgres's set-returning functions). The
// dataset keeps one output row for each key, as for a Rule, and one row for
// each part beside it. A part gives the values of its content columns, what
// the part is, and of its place columns, where the part is in its input, as
// LlamaIndex keeps the offsets of a node beside its text.
export abstract class TableRule<
  Input,
  Columns extends RuleColumns,
  Place extends RuleColumns,
> {
  // The output's key column: the input's own key, such as a file's ref.
  abstract readonly key: {
    readonly name: string;
    readonly description: string;
  };
  // The content columns of each part, which its part hash covers.
  abstract readonly output: Columns;
  // The place columns of each part, which its part hash does not cover, so a
  // part that only moved keeps its part hash.
  abstract readonly place: Place;
  // As for a Rule: the inputs of one compute call, and the calls at once.
  abstract readonly batch: number;
  abstract readonly concurrency: number;

  // The key and input of one loaded row, or null when the row has none.
  abstract read(
    row: LoadedRow,
  ): { readonly key: string; readonly input: Input } | null;

  // What would make the parts of input. null means the rule does not handle
  // the input: an output made before stays, and a missing one is stored empty.
  abstract identity(input: Input): Promise<string | null>;

  // One result for each input, in order.
  abstract compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<
    readonly TableRuleResult<RuleValues<Columns> & RuleValues<Place>>[]
  >;
}
