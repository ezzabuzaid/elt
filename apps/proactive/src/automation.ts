import type postgres from 'postgres';

import type { Condition, Match } from '@workspace/eca';

// When something starts to be true in the warehouse, do something about it.
// evaluate is the eca condition: what is true now. act does the work for one
// new match and returns a short receipt, which the user sees.
export abstract class Automation<Data> implements Condition<
  postgres.Sql,
  Data
> {
  abstract evaluate(sql: postgres.Sql): Promise<readonly Match<Data>[]>;
  abstract act(match: Match<Data>, signal: AbortSignal): Promise<string>;
}
