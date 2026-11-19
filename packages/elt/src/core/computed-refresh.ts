import { hash } from 'node:crypto';

import { Vector } from '@zukhruf/vectors';

import { errorMessage } from '../state/sync-history.ts';
import type { RefreshTrigger } from './derived-dataset.ts';
import type { DerivedStatus } from './derived-status.ts';
import type { Rule, RuleColumns, RuleValues } from './rule.ts';

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

// What a refresh compares of a stored output row.
export type StoredOutput = {
  readonly inputHash: string;
  readonly rule: string;
  readonly status: string;
};

// One output row that a refresh writes.
export type OutputRow = {
  readonly key: string;
  readonly inputHash: string;
  readonly rule: string;
  readonly status: 'computed' | 'empty' | 'failed';
  readonly error: string | null;
  readonly values: RuleValues<RuleColumns>;
};

// The output table of a computed dataset once its refresh prepared it, as its
// destination keeps it. Each write is one commit, and a row with the values
// that the stored row has keeps its commit.
export type PreparedOutputs = {
  // Each stored row whose key has an input.
  readonly stored: ReadonlyMap<string, StoredOutput>;
  // Writes the row of an input that the rule does not handle.
  store(row: OutputRow): Promise<void>;
  // Writes the rows of one call, and takes settled inputs off the pending
  // count of the dataset's status in the same commit.
  settle(rows: readonly OutputRow[], settled: number): Promise<void>;
  // How many output rows have each status that some row has.
  counts(): Promise<ReadonlyMap<string, number>>;
};

// Brings the outputs of a computed dataset in step with its inputs, as pgai's
// vectorizer keeps an embedding beside each row: prepare makes the table
// match its declaration, removes each row whose input is gone and gives the
// others; then the rule makes each row whose input or rule changed, and a
// refresh after the passes also tries failed rows again. The passes try each
// input at most once, so a failing rule is asked once a pass. A rule's
// failure on one input is that row's; it never fails the load. inputs is
// null while a relation that the dataset reads is gone: the dataset waits
// with what it made, as a view waits. A value that does not fit its column,
// such as a vector of other dimensions, fails its row.
export async function refreshComputed<Input>({
  rule,
  inputs,
  prepare,
  status,
  trigger,
  signal,
}: {
  readonly rule: Rule<Input, RuleColumns>;
  readonly inputs: ReadonlyMap<string, Input> | null;
  readonly prepare: (keys: ReadonlySet<string>) => Promise<PreparedOutputs>;
  readonly status: DerivedStatus;
  readonly trigger: RefreshTrigger;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  if (inputs === null) {
    await status.waiting();
    return;
  }
  try {
    await update(rule, inputs, prepare, status, trigger, signal);
  } catch (error) {
    // A stop is not the dataset's failure.
    if (signal?.aborted !== true) await status.failed(errorMessage(error));
    throw error;
  }
}

async function update<Input>(
  rule: Rule<Input, RuleColumns>,
  inputs: ReadonlyMap<string, Input>,
  prepare: (keys: ReadonlySet<string>) => Promise<PreparedOutputs>,
  status: DerivedStatus,
  trigger: RefreshTrigger,
  signal: AbortSignal | undefined,
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
        values: {},
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
  // workers busy. A call that fails stops the pool taking more.
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
          batch.flatMap(
            ({ key, inputHash, rule: identity }, index): OutputRow[] => {
              const result = results[index];
              if (result === undefined || 'gone' in result) return [];
              const row = {
                key,
                inputHash,
                rule: identity,
                error: null,
                values: {},
              };
              if ('value' in result) {
                const misfit = misfits(rule.output, result.value);
                return [
                  misfit === undefined
                    ? { ...row, status: 'computed', values: result.value }
                    : { ...row, status: 'failed', error: misfit },
                ];
              }
              if ('error' in result)
                return [{ ...row, status: 'failed', error: result.error }];
              return [{ ...row, status: 'empty' }];
            },
          ),
          batch.length,
        );
      }
    }),
  );
  if (failures.length > 0) throw failures[0];
  if (signal?.aborted === true) return;
  await status.current({
    ...counts(await outputs.counts(), inputs),
    pending: 0,
  });
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
