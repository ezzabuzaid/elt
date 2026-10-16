import type { Failure, NewMatch, Rule } from './rule.ts';
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
  // that start to match after it was added. A host that saved the rule's keys
  // before a restart gives them back instead, so the rule yields a key that
  // started to match while the host was down.
  async add(
    rule: Rule<Sql, Data>,
    options?: { readonly keys?: Iterable<string> },
  ): Promise<void> {
    this.#rules.push({
      rule,
      keys: new Set(options?.keys ?? (await this.#evaluate(rule)).keys()),
    });
  }

  // The keys a host saves to give the rule back after a restart. They hold a
  // new match only once the host moved past it, so a host that stops while it
  // acts on a match hears of it again.
  keys(rule: Rule<Sql, Data>): ReadonlySet<string> {
    const watched = this.#rules.find((candidate) => candidate.rule === rule);
    if (watched === undefined)
      throw new TypeError('This rule was not added to this eca.');
    return watched.keys;
  }

  // Each commit to the warehouse evaluates every rule. A rule moves on to its
  // new keys only when the host pulls past its last new match, so a match the
  // host stopped at comes again to its next watch. A rule whose condition
  // throws is yielded as a failure, and the other rules still run.
  async *watch({
    signal,
  }: {
    readonly signal: AbortSignal;
  }): AsyncGenerator<NewMatch<Sql, Data> | Failure<Sql, Data>> {
    for await (const _ of this.#warehouse.commits(signal))
      for (const watched of this.#rules) {
        let matches: ReadonlyMap<string, Data>;
        try {
          matches = await this.#evaluate(watched.rule);
        } catch (error) {
          yield { rule: watched.rule, error };
          continue;
        }
        for (const [key, data] of matches)
          if (!watched.keys.has(key)) yield { rule: watched.rule, key, data };
        watched.keys = new Set(matches.keys());
      }
  }

  async #evaluate(rule: Rule<Sql, Data>): Promise<ReadonlyMap<string, Data>> {
    return new Map(
      (await rule.condition.evaluate(this.#warehouse.sql)).map(
        ({ key, data }) => [key, data],
      ),
    );
  }
}
