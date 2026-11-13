import type { Reading } from './warehouse.ts';

/**
 * What became true between two readings of the warehouse: the agent writes it
 * as code, with SQL in it, and it gives what matches in `after` that did not
 * in `before`. `before.at` and `after.at` bound the time it covers, so a
 * condition on time, such as a deadline that passes, matches once.
 */
export interface Condition<Sql, Data> {
  evaluate(before: Reading<Sql>, after: Reading<Sql>): Promise<readonly Data[]>;
}

/**
 * The host's own object: an outcome carries it back, with the host's own type,
 * so the host knows which rule it is about.
 */
export type Rule<Sql, Data> = { readonly condition: Condition<Sql, Data> };

/**
 * What one evaluation of a rule gives. The host saves the matches and the new
 * cursor together, in one transaction of its own, and gives that cursor back
 * at the next evaluation.
 * - The walk ended: each match of each step, and the cursor at the newest
 *   position.
 * - The condition threw at a step: the matches of the steps before it, the
 *   error, and the cursor after the last good step.
 * - The cursor names a position that the warehouse can no longer read, such
 *   as one older than its retention or of a warehouse made again.
 */
export type Outcome<Sql, Data, R extends Rule<Sql, Data> = Rule<Sql, Data>> =
  | {
      readonly rule: R;
      readonly matches: readonly Data[];
      readonly cursor: string;
    }
  | {
      readonly rule: R;
      readonly matches: readonly Data[];
      readonly error: unknown;
      readonly cursor: string;
    }
  | { readonly rule: R; readonly expired: string };
