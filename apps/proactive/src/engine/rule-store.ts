import type { DatabaseSync } from 'node:sqlite';

import { open } from '@zukhruf/sqlite-open';

// A rule that the user wrote, as proactive keeps it: the user's words, the
// SQL that gives what is true, and one action.
export type StoredRule = {
  readonly name: string;
  readonly when: string;
  readonly sql: string;
} & (
  | { readonly notify: string; readonly agent?: never }
  | { readonly agent: string; readonly notify?: never }
);

// The rules that users wrote, in a SQLite file of proactive's own. They are
// not in the warehouse, which a fresh run makes again: a rule is what a user
// wrote, not data that a run derives. The table refuses a rule with no action
// or two, also when a row is written by hand.
export class RuleStore implements Disposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = open(path);
    this.#database.exec(`CREATE TABLE IF NOT EXISTS rules (
      name TEXT PRIMARY KEY,
      "when" TEXT NOT NULL,
      sql TEXT NOT NULL,
      notify TEXT,
      agent TEXT,
      CHECK ((notify IS NULL) <> (agent IS NULL))
    ) STRICT`);
  }

  add(rule: StoredRule): void {
    this.#database
      .prepare(
        'INSERT INTO rules (name, "when", sql, notify, agent) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        rule.name,
        rule.when,
        rule.sql,
        rule.notify ?? null,
        rule.agent ?? null,
      );
  }

  rules(): StoredRule[] {
    return this.#database
      .prepare(
        'SELECT name, "when", sql, notify, agent FROM rules ORDER BY name',
      )
      .all()
      .map(({ name, when, sql, notify, agent }) => {
        if (
          typeof name !== 'string' ||
          typeof when !== 'string' ||
          typeof sql !== 'string'
        )
          throw new TypeError('A stored rule has no name, words or SQL');
        if (typeof notify === 'string') return { name, when, sql, notify };
        if (typeof agent === 'string') return { name, when, sql, agent };
        throw new TypeError(`The stored rule ${name} has no action`);
      });
  }

  [Symbol.dispose](): void {
    this.#database.close();
  }
}
