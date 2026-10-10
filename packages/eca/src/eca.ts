import { Imports } from './imports.ts';
import type { Match, Rule } from './rule.ts';
import { Store } from './store.ts';

export class Eca implements Disposable {
  readonly #imports: Imports;
  readonly #store: Store;
  // Each added rule, run again by the commits its condition read.
  readonly #rules = new Map<string, () => Promise<void>>();

  constructor(options: {
    readonly store: string;
    readonly imports: Readonly<Record<string, string>>;
  }) {
    this.#imports = new Imports(options.imports);
    this.#store = new Store(options.store);
  }

  // A rule the store has not seen starts from what its condition matches now,
  // so its action hears only of commits made after the rule was added.
  add<Data>(rule: Rule<Data>): void {
    if (!this.#store.has(rule.id)) {
      const { matches, reads } = this.#imports.evaluate(rule.condition);
      this.#store.save(rule.id, fingerprints(matches), reads);
    }
    this.#rules.set(rule.id, async () => {
      const previous = this.#store.matches(rule.id);
      const { matches, reads } = this.#imports.evaluate(rule.condition);
      const current = fingerprints(matches);
      for (const { key, data } of matches) {
        const before = previous.get(key);
        if (before === undefined)
          await rule.action.run({ type: 'started', rule: rule.id, key, data });
        else if (before !== current.get(key))
          await rule.action.run({ type: 'changed', rule: rule.id, key, data });
      }
      for (const key of previous.keys())
        if (!current.has(key))
          await rule.action.run({ type: 'ended', rule: rule.id, key });
      this.#store.save(rule.id, current, reads);
    });
  }

  // The host reports which tables of an import a commit wrote; every rule
  // whose condition read one of them runs again.
  async committed(name: string, tables: readonly string[]): Promise<void> {
    for (const [id, run] of this.#rules) {
      const read = this.#store.reads(id).get(name);
      if (tables.some((table) => read?.has(table))) await run();
    }
  }

  [Symbol.dispose](): void {
    this.#imports[Symbol.dispose]();
    this.#store[Symbol.dispose]();
  }
}

// Each key a condition matched, with its data as JSON to tell a change.
const fingerprints = (matches: readonly Match<unknown>[]) =>
  new Map(matches.map(({ key, data }) => [key, JSON.stringify(data)]));
