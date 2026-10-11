// One thing a condition matched. Its key names it across evaluations, so the
// host hears of it once while the condition keeps matching it.
export type Match<Data> = { readonly key: string; readonly data: Data };

// What is true now, read from the warehouse through sql. The agent writes it
// as code, with SQL in it.
export interface Condition<Sql, Data> {
  evaluate(sql: Sql): readonly Match<Data>[];
}

// The host's own object: a new match carries it back, so the host knows which
// rule matched.
export type Rule<Sql, Data> = { readonly condition: Condition<Sql, Data> };

// A key the rule's condition matched that it did not match in the previous
// evaluation: the moment the host acts.
export type NewMatch<Sql, Data> = Match<Data> & {
  readonly rule: Rule<Sql, Data>;
};
