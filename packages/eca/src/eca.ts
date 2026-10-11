import type { NewMatch, Rule } from './rule.ts';
import type { Warehouse } from './warehouse.ts';

type Watched<Sql, Data> = {
  readonly rule: Rule<Sql, Data>;
  // The keys the condition matched when the host last moved past its matches.
  keys: ReadonlySet<string>;
};

export class Eca<Sql, Data> {
  readonly #warehouse: Warehouse<Sql>;
  readonly #rules: Watched<Sql, Data>[] = [];

  constructor(options: { readonly warehouse: Warehouse<Sql> }) {
    this.#warehouse = options.warehouse;
  }

  // A rule starts from what its condition matches now, so it yields only keys
  // that start to match after it was added.
  add(rule: Rule<Sql, Data>): void {
    this.#rules.push({ rule, keys: new Set(this.#evaluate(rule).keys()) });
  }

  // Each commit to the warehouse evaluates every rule. A rule moves on to its
  // new keys only when the host pulls past its last new match, so a match the
  // host stopped at comes again to its next watch.
  async *watch({
    signal,
  }: {
    readonly signal: AbortSignal;
  }): AsyncGenerator<NewMatch<Sql, Data>> {
    for await (const _ of this.#warehouse.commits(signal))
      for (const watched of this.#rules) {
        const matches = this.#evaluate(watched.rule);
        for (const [key, data] of matches)
          if (!watched.keys.has(key)) yield { rule: watched.rule, key, data };
        watched.keys = new Set(matches.keys());
      }
  }

  #evaluate(rule: Rule<Sql, Data>): ReadonlyMap<string, Data> {
    return new Map(
      rule.condition
        .evaluate(this.#warehouse.sql)
        .map(({ key, data }) => [key, data]),
    );
  }
}
