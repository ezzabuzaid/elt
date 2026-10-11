// One thing a condition matched. Its key names it across evaluations, so the
// host hears of it once, however often the condition matches it again.
export type Match<Data> = { readonly key: string; readonly data: Data };

// What is true now, read from the warehouse through sql. The agent writes it
// as code, with SQL in it.
export interface Condition<Sql, Data> {
  evaluate(sql: Sql): readonly Match<Data>[];
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

// The id names the rule in each of its changes.
export type Rule<Sql, Data> = {
  readonly id: string;
  readonly condition: Condition<Sql, Data>;
};
