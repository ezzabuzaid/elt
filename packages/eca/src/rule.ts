import type { SQLTagStore } from 'node:sqlite';

// One thing a condition matched. Its key names it across evaluations, so the
// action hears of it once, however often the condition matches it again.
export type Match<Data> = { readonly key: string; readonly data: Data };

// What is true now, read from the imports through sql. The agent writes it as
// code; eca learns which tables it read from the queries it runs.
export interface Condition<Data> {
  evaluate(sql: SQLTagStore): readonly Match<Data>[];
}

// How a match moved since the previous evaluation.
export type Change<Data> =
  | {
      readonly type: 'started' | 'changed';
      readonly rule: string;
      readonly key: string;
      readonly data: Data;
    }
  | { readonly type: 'ended'; readonly rule: string; readonly key: string };

// What the user wants done; eca only calls it.
export interface Action<Data> {
  run(change: Change<Data>): Promise<void> | void;
}

// The id names the rule's stored matches across restarts.
export type Rule<Data> = {
  readonly id: string;
  readonly condition: Condition<Data>;
  readonly action: Action<Data>;
};
