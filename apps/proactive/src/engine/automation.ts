import type postgres from 'postgres';

import type { Condition, Reading } from '@eltjs/eca';

// When something starts to be true in the warehouse, do something about it.
// evaluate is the eca condition: what matches in after that did not match in
// before. act does the work for one match and returns a short receipt, which
// the user sees.
export abstract class Automation<Data> implements Condition<
  postgres.Sql,
  Data
> {
  abstract evaluate(
    before: Reading<postgres.Sql>,
    after: Reading<postgres.Sql>,
  ): Promise<readonly Data[]>;
  abstract act(match: Data, signal: AbortSignal): Promise<string>;
}
