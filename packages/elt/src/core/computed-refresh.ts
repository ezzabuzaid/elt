import { createHash, hash } from 'node:crypto';

import { Vector } from '@zukhruf/vectors';
import { toSql } from '@zukhruf/vectors/sqlite';

import { errorMessage } from '../state/sync-history.ts';
import type { RefreshTrigger } from './derived-dataset.ts';
import type { DerivedStatus } from './derived-status.ts';
import { EscalatedFailure } from './escalated-failure.ts';
import type { Rule, RuleColumns, RuleValues } from './rule.ts';
import { TableRule } from './table-rule.ts';

// The columns a computed dataset keeps on every output row beside its rule's
// own, with what readers read of each.
export const computedColumns = {
  input_hash:
    'SHA-256 of the input the row was made from; the row is made again when its input changes.',
  rule: 'What made the row, such as the parser of its format or the model; the row is made again when that changes. unsupported: the rule does not handle the input.',
  status:
    'computed: the rule made the row. empty: the rule found nothing to keep, such as a photo without words. failed: the rule failed, error says why, and the refresh after the passes tries again, at most once for each pass.',
  error: 'Why the rule failed. NULL unless status is failed.',
};

// The columns a parts table keeps beside the table rule's own, with what
// readers read of each.
export const partColumns = {
  seq: 'The order of the part in its input, from 0.',
  part_hash:
    'SHA-256 of the content columns of the part, not of its place columns: a part that only moved keeps its part hash.',
};

// The view that readers query the parts of a computed dataset through,
// <dataset>_parts: what it holds, and each column in table order with what
// readers read of it: the key, the part columns, the content columns and the
// place columns of the rule.
export function partsView({
  dataset,
  description,
  rule,
}: {
  readonly dataset: string;
  readonly description: string;
  readonly rule: Pick<
    TableRule<unknown, RuleColumns, RuleColumns>,
    'key' | 'output' | 'place'
  >;
}): {
  readonly name: string;
  readonly description: string;
  readonly columns: readonly {
    readonly name: string;
    readonly description: string;
  }[];
} {
  return {
    name: `${dataset}_parts`,
    description: `The parts of ${dataset}, one row for each part of an input, in order: ${description}`,
    columns: [
      rule.key,
      ...Object.entries(partColumns).map(([name, about]) => ({
        name,
        description: about,
      })),
      ...[rule.output, rule.place].flatMap((group) =>
        Object.entries(group).map(([name, column]) => ({
          name,
          description: column.description,
        })),
      ),
    ],
  };
}

// The names that no column of the rule may take, since the tables and the
// histories of the dataset keep them: the key, the computed columns, the part
// columns of a table rule, the commit that last wrote a row and the hash of
// its values in each table, and the commit that replaced a row in each
// history. A destination compares a rule column with each name as its store
// compares two names.
export function reservedColumns<Input>(
  rule: Rule<Input, RuleColumns> | TableRule<Input, RuleColumns, RuleColumns>,
): readonly string[] {
  return [
    rule.key.name,
    ...Object.keys(computedColumns),
    ...(rule instanceof TableRule ? Object.keys(partColumns) : []),
    'committed_in',
    '_elt_row_hash',
    'replaced_in',
  ];
}

// Refuses a column of the rule, of either group of a table rule, whose name
// is one of reserved or the name of another column of the rule, as key
// gives the form two names share when the store takes them for one.
// reserved holds reservedColumns(rule) and each other column that the
// destination keeps in the tables of the dataset.
export function refuseTakenColumns<Input>({
  dataset,
  rule,
  reserved,
  key,
}: {
  readonly dataset: string;
  readonly rule:
    Rule<Input, RuleColumns> | TableRule<Input, RuleColumns, RuleColumns>;
  readonly reserved: readonly string[];
  readonly key: (name: string) => string;
}): void {
  const taken = new Map(reserved.map((column) => [key(column), column]));
  for (const column of [
    ...Object.keys(rule.output),
    ...(rule instanceof TableRule ? Object.keys(rule.place) : []),
  ]) {
    const other = taken.get(key(column));
    if (other !== undefined)
      throw new TypeError(
        `Computed dataset ${dataset} cannot have the column ${column}: the dataset already has the column ${other}`,
      );
    taken.set(key(column), column);
  }
}

// What a refresh compares of a stored output row.
export type StoredOutput = {
  readonly inputHash: string;
  readonly rule: string;
  readonly status: string;
};

// The columns that each output row has, whatever the rule made.
type OutputHead = {
  readonly key: string;
  readonly inputHash: string;
  readonly rule: string;
};

// An output row with nothing made: empty, or a rule failure with why.
export type UnmadeRow = OutputHead &
  (
    | { readonly status: 'empty'; readonly error: null }
    | { readonly status: 'failed'; readonly error: string }
  );

// One output row of a Rule that a refresh writes: only a computed row has
// values.
export type OutputRow =
  | (OutputHead & {
      readonly status: 'computed';
      readonly error: null;
      readonly values: RuleValues<RuleColumns>;
    })
  | UnmadeRow;

// One part of a computed row of a TableRule: its part hash, and the values of
// its content and place columns. Its index in the parts of its row is its seq.
export type PartRow = {
  readonly partHash: string;
  readonly values: RuleValues<RuleColumns>;
};

// One output row of a TableRule that a refresh writes: only a computed row
// has parts, one or more. The destination keeps no other part of its key.
export type TableOutputRow =
  | (OutputHead & {
      readonly status: 'computed';
      readonly error: null;
      readonly parts: readonly [PartRow, ...PartRow[]];
    })
  | UnmadeRow;

// The output table of a computed dataset once its refresh prepared it, as its
// destination keeps it. Each write is one commit, and a row with the values
// that the stored row has keeps its commit.
export type PreparedOutputs<Row> = {
  // Each stored row whose key has an input.
  readonly stored: ReadonlyMap<string, StoredOutput>;
  // Writes the row of an input that the rule does not handle.
  store(row: UnmadeRow): Promise<void>;
  // Writes the rows of one call, and takes settled inputs off the pending
  // count of the dataset's status in the same commit.
  settle(rows: readonly Row[], settled: number): Promise<void>;
  // How many output rows have each status that some row has.
  counts(): Promise<ReadonlyMap<string, number>>;
};

type Refresh<Input, Compute, Row> = {
  readonly rule: Compute;
  readonly inputs: () => Promise<ReadonlyMap<string, Input> | null>;
  readonly prepare: (
    keys: ReadonlySet<string>,
  ) => Promise<PreparedOutputs<Row>>;
  readonly status: DerivedStatus;
  readonly trigger: RefreshTrigger;
  readonly signal: AbortSignal | undefined;
};

type RuleRefresh<Input> = Refresh<Input, Rule<Input, RuleColumns>, OutputRow>;

type TableRuleRefresh<Input> = Refresh<
  Input,
  TableRule<Input, RuleColumns, RuleColumns>,
  TableOutputRow
>;

// Brings the outputs of a computed dataset in step with its inputs, as pgai's
// vectorizer keeps an embedding beside each row: prepare makes the table
// match its declaration, removes each row whose input is gone and gives the
// others; then the rule makes each row whose input or rule changed, and a
// refresh after the passes also tries failed rows again. The passes try each
// input at most once, so a failing rule is asked once a pass. A rule's
// failure on one input is that row's; it never fails the load. inputs reads
// the inputs, or gives null while a relation that the dataset reads is gone:
// the dataset waits with what it made, as a view waits. Each other failure,
// also one of inputs, is the dataset's own, which its status records. A
// value that does not fit its column, such as a vector of other dimensions,
// fails its row. The kind of the rule sets what a computed row holds: the
// values of a Rule, or the parts of a TableRule, each with its part hash.
export async function refreshComputed<Input>(
  refresh: RuleRefresh<Input>,
): Promise<void>;
export async function refreshComputed<Input>(
  refresh: TableRuleRefresh<Input>,
): Promise<void>;
export async function refreshComputed<Input>(
  refresh: RuleRefresh<Input> | TableRuleRefresh<Input>,
): Promise<void> {
  const { status, signal } = refresh;
  try {
    const inputs = await refresh.inputs();
    if (inputs === null) {
      await status.waiting();
      return;
    }
    if (ofTableRule(refresh)) {
      const { rule } = refresh;
      await update(refresh, inputs, (head, result) =>
        'parts' in result
          ? partsRow(rule, head, result.parts)
          : unmade(head, result),
      );
    } else {
      const { rule } = refresh;
      await update(refresh, inputs, (head, result) =>
        'value' in result
          ? valuesRow(rule.output, head, result.value)
          : unmade(head, result),
      );
    }
  } catch (error) {
    // A stop is not the dataset's failure, and neither is an escalated
    // failure (ADR 0037).
    if (signal?.aborted !== true && !(error instanceof EscalatedFailure))
      await status.failed(errorMessage(error));
    throw error;
  }
}

// A TableRule is no Rule, so the kind of the rule gives the kind of the rows
// that prepare takes.
function ofTableRule<Input>(
  refresh: RuleRefresh<Input> | TableRuleRefresh<Input>,
): refresh is TableRuleRefresh<Input> {
  return refresh.rule instanceof TableRule;
}

// What both kinds of rule have, by which a refresh asks them.
type Computes<Input, Result> = {
  readonly batch: number;
  readonly concurrency: number;
  identity(input: Input): Promise<string | null>;
  compute(
    inputs: readonly Input[],
    signal?: AbortSignal,
  ): Promise<readonly (Result | { readonly gone: true })[]>;
};

async function update<Input, Result, Row>(
  {
    rule,
    prepare,
    status,
    trigger,
    signal,
  }: {
    readonly rule: Computes<Input, Result>;
    readonly prepare: (
      keys: ReadonlySet<string>,
    ) => Promise<PreparedOutputs<Row>>;
    readonly status: DerivedStatus;
    readonly trigger: RefreshTrigger;
    readonly signal: AbortSignal | undefined;
  },
  inputs: ReadonlyMap<string, Input>,
  made: (head: OutputHead, result: Result) => Row,
): Promise<void> {
  const outputs = await prepare(new Set(inputs.keys()));
  const due: {
    readonly key: string;
    readonly input: Input;
    readonly inputHash: string;
    readonly rule: string;
  }[] = [];
  for (const [key, input] of inputs) {
    if (signal?.aborted) return;
    const inputHash = hash('sha256', JSON.stringify(input));
    const identity = await rule.identity(input);
    const before = outputs.stored.get(key);
    // A rule that does not handle the input keeps what it made before.
    if (identity === null) {
      if (before?.status === 'computed') continue;
      if (before?.rule === 'unsupported' && before.inputHash === inputHash)
        continue;
      await outputs.store({
        key,
        inputHash,
        rule: 'unsupported',
        status: 'empty',
        error: null,
      });
      continue;
    }
    if (
      before !== undefined &&
      before.inputHash === inputHash &&
      before.rule === identity
    ) {
      // A failed input waits for the refresh after the passes.
      if (before.status !== 'failed' || trigger.kind === 'commit') continue;
    }
    // The passes try each input, as it is now, at most once: the refresh
    // after them leaves what a commit refresh of the same passes tried.
    const attempt = `${key}\0${inputHash}\0${identity}`;
    if (trigger.tried.has(attempt)) continue;
    if (trigger.kind === 'commit') trigger.tried.add(attempt);
    due.push({ key, input, inputHash, rule: identity });
  }
  await status.refreshing({
    ...counts(await outputs.counts(), inputs),
    pending: due.length,
  });
  // A pool of calls, each taking the next batch once its own committed, so
  // a slow call holds only its place, as a worker pool keeps its other
  // workers busy. A call that fails stops the pool taking more. An escalated
  // failure of any call is the refresh's, so a failure of another call
  // beside it does not hide it (ADR 0037).
  const failures: unknown[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: rule.concurrency }, async () => {
      while (failures.length === 0 && signal?.aborted !== true) {
        const batch = due.slice(next, next + rule.batch);
        next += rule.batch;
        if (batch.length === 0) return;
        let results;
        try {
          results = await rule.compute(
            batch.map(({ input }) => input),
            signal,
          );
        } catch (error) {
          failures.push(error);
          return;
        }
        // Each call commits on its own, so readers see rows as they land.
        await outputs.settle(
          batch.flatMap(({ key, inputHash, rule: identity }, index) => {
            const result = results[index];
            if (result === undefined || isGone(result)) return [];
            return [made({ key, inputHash, rule: identity }, result)];
          }),
          batch.length,
        );
      }
    }),
  );
  if (failures.length > 0)
    throw (
      failures.find((failure) => failure instanceof EscalatedFailure) ??
      failures[0]
    );
  if (signal?.aborted === true) return;
  await status.current({
    ...counts(await outputs.counts(), inputs),
    pending: 0,
  });
}

// An input that was gone before the rule read it gets no row.
function isGone<Result>(
  result: Result | { readonly gone: true },
): result is { readonly gone: true } {
  return typeof result === 'object' && result !== null && 'gone' in result;
}

// The row of an input with nothing made: empty, or the rule's failure.
function unmade(
  head: OutputHead,
  result: { readonly empty: true } | { readonly error: string },
): UnmadeRow {
  return 'error' in result
    ? { ...head, status: 'failed', error: result.error }
    : { ...head, status: 'empty', error: null };
}

// The row of a Rule's value, or its failure when a value does not fit.
function valuesRow(
  columns: RuleColumns,
  head: OutputHead,
  values: RuleValues<RuleColumns>,
): OutputRow {
  const misfit = misfits(columns, values);
  return misfit === undefined
    ? { ...head, status: 'computed', error: null, values }
    : { ...head, status: 'failed', error: misfit };
}

// The row of a TableRule's parts, each with its part hash, or the failure
// of the input when a value of a part does not fit its column.
function partsRow(
  rule: Pick<TableRule<unknown, RuleColumns, RuleColumns>, 'output' | 'place'>,
  head: OutputHead,
  parts: readonly [RuleValues<RuleColumns>, ...RuleValues<RuleColumns>[]],
): TableOutputRow {
  for (const [seq, values] of parts.entries()) {
    const misfit = misfits(rule.output, values) ?? misfits(rule.place, values);
    if (misfit !== undefined)
      return { ...head, status: 'failed', error: `Part ${seq}: ${misfit}` };
  }
  const [first, ...rest] = parts;
  const part = (values: RuleValues<RuleColumns>): PartRow => ({
    partHash: partHash(rule.output, values),
    values,
  });
  return {
    ...head,
    status: 'computed',
    error: null,
    parts: [part(first), ...rest.map(part)],
  };
}

// The part hash: the SHA-256, in lowercase hex, of the content columns of a
// part, never of its seq or its place columns. Each content column that has a
// value counts, in the order of the names (JavaScript's sort, by UTF-16 code
// unit), as `c<n>:<name>` and then its value as `<tag><n>:<bytes>`, where
// <n> is the count of bytes in decimal: `t` and the UTF-8 of a text, `n` and
// the decimal digits of an integer, `b` and the bytes of a blob, `v` and the
// float32 values of a vector, little-endian (toSql of
// @zukhruf/vectors/sqlite). A column with no value does not
// count, so a content column that a rule adds keeps the part hash of each
// part that has no value for it, as the row hash of a copy does.
function partHash(
  columns: RuleColumns,
  values: RuleValues<RuleColumns>,
): string {
  const digest = createHash('sha256');
  const add = (tag: string, bytes: Uint8Array) => {
    digest.update(`${tag}${bytes.byteLength}:`);
    digest.update(bytes);
  };
  const utf8 = new TextEncoder();
  for (const name of Object.keys(columns).toSorted()) {
    const value = values[name];
    if (value === undefined) continue;
    add('c', utf8.encode(name));
    if (typeof value === 'string') add('t', utf8.encode(value));
    else if (typeof value === 'number') add('n', utf8.encode(String(value)));
    else if (value instanceof Vector) add('v', toSql(value));
    else add('b', value);
  }
  return digest.digest('hex');
}

// Why a value does not fit its column, for the first value that does not:
// an integer column takes a safe integer, which each destination keeps
// exactly, and a vector column a vector of its dimensions.
function misfits(
  columns: RuleColumns,
  values: RuleValues<RuleColumns>,
): string | undefined {
  for (const [name, column] of Object.entries(columns)) {
    const value = values[name];
    if (value === undefined) continue;
    if (column.type === 'integer' && !Number.isSafeInteger(value))
      return `The column ${name} takes a safe integer, and the rule gave ${String(value)}.`;
    if (
      column.type === 'vector' &&
      value instanceof Vector &&
      value.dimensions !== column.dimensions
    )
      return `The column ${name} takes a vector of ${column.dimensions} dimensions, and the rule gave one of ${value.dimensions}.`;
  }
  return undefined;
}

// How many inputs there are, and how many output rows have each status. A
// status that no row has is absent from the counts that a GROUP BY gives.
function counts(
  byStatus: ReadonlyMap<string, number>,
  inputs: ReadonlyMap<string, unknown>,
): { inputs: number; computed: number; empty: number; failed: number } {
  return {
    inputs: inputs.size,
    computed: byStatus.get('computed') ?? 0,
    empty: byStatus.get('empty') ?? 0,
    failed: byStatus.get('failed') ?? 0,
  };
}
