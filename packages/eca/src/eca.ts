import { isDeepStrictEqual } from 'node:util';

import type { Change, Rule } from './rule.ts';
import type { Warehouse } from './warehouse.ts';

type Watched<Sql, Data> = {
  readonly rule: Rule<Sql, Data>;
  // What the condition matched when the host last moved past its changes.
  matches: ReadonlyMap<string, Data>;
};

export class Eca<Sql, Data> {
  readonly #warehouse: Warehouse<Sql>;
  readonly #rules: Watched<Sql, Data>[] = [];

  constructor(options: { readonly warehouse: Warehouse<Sql> }) {
    this.#warehouse = options.warehouse;
  }

  // A rule starts from what its condition matches now, so it reports only what
  // changes after it was added.
  add(rule: Rule<Sql, Data>): void {
    this.#rules.push({ rule, matches: this.#evaluate(rule) });
  }

  // Each commit to the warehouse evaluates every rule. A rule moves on to its
  // new matches only when the host pulls past its last change, so a change the
  // host stopped at comes again to its next watch.
  async *watch({
    signal,
  }: {
    readonly signal: AbortSignal;
  }): AsyncGenerator<Change<Data>> {
    for await (const _ of this.#warehouse.commits(signal))
      for (const watched of this.#rules) {
        const { id } = watched.rule;
        const matches = this.#evaluate(watched.rule);
        for (const [key, data] of matches) {
          if (!watched.matches.has(key))
            yield { type: 'started', rule: id, key, data };
          else if (!isDeepStrictEqual(watched.matches.get(key), data))
            yield { type: 'changed', rule: id, key, data };
        }
        for (const key of watched.matches.keys())
          if (!matches.has(key)) yield { type: 'ended', rule: id, key };
        watched.matches = matches;
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
