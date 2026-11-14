import type postgres from 'postgres';

// One thing an automation matched. Its key names it across evaluations, so
// the user hears of it once while the automation keeps matching it.
export type Match<Data> = { readonly key: string; readonly data: Data };

// When something starts to be true in the warehouse, do something about it.
// evaluate gives what is true in the warehouse that sql reads, at the time
// at. act does the work for one new match and returns a short receipt, which
// the user sees.
export abstract class Automation<Data> {
  abstract evaluate(
    sql: postgres.Sql,
    at: Temporal.Instant,
  ): Promise<readonly Match<Data>[]>;
  abstract act(match: Match<Data>, signal: AbortSignal): Promise<string>;
}
