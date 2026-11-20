import type { DatabaseSync } from 'node:sqlite';

import {
  type PartRow,
  type RuleColumns,
  type TableRule,
  partsView,
} from '@eltjs/elt';

import { SQLiteHistory, rowHash } from './sqlite-history.ts';
import { identifiers, quote, rawTable } from './sqlite-identifiers.ts';
import { ruleColumnTypes, ruleValue } from './sqlite-rule-columns.ts';
import type { SQLiteView } from './sqlite-views.ts';

// The parts of a computed dataset whose rule is a table rule, in the table
// raw_<name>_parts beside the output rows of raw_<name>: one row for each
// part, unique on the key and seq, with the content columns and the place
// columns of the rule. Readers query the view <name>_parts. Each row names
// the commit that last wrote it, and the history keeps each row a commit
// replaced or removed, as for the output rows.
export class SQLitePartsTable {
  readonly #name: string;
  readonly #view: ReturnType<typeof partsView>;
  readonly #key: string;
  readonly #history: SQLiteHistory;
  // Every column of a part that readers see, in table order.
  readonly #columns: readonly string[];
  readonly statement: string;

  constructor({
    dataset,
    description,
    rule,
  }: {
    dataset: string;
    description: string;
    rule: Pick<
      TableRule<unknown, RuleColumns, RuleColumns>,
      'key' | 'output' | 'place'
    >;
  }) {
    this.#view = partsView({ dataset, description, rule });
    this.#name = rawTable(this.#view.name);
    this.#key = rule.key.name;
    this.#history = new SQLiteHistory({
      raw: this.#name,
      location: identifiers.key(this.#name),
    });
    const ruleColumns = { ...rule.output, ...rule.place };
    this.#columns = Object.freeze(this.#view.columns.map(({ name }) => name));
    this.statement = `CREATE TABLE ${quote(this.#name)} (${[
      `${quote(rule.key.name)} TEXT NOT NULL`,
      '"seq" INTEGER NOT NULL',
      '"part_hash" TEXT NOT NULL',
      ...Object.entries(ruleColumns).map(
        ([column, { type }]) => `${quote(column)} ${ruleColumnTypes[type]}`,
      ),
      '"committed_in" INTEGER NOT NULL',
      '"_elt_row_hash" TEXT NOT NULL',
      `PRIMARY KEY (${quote(rule.key.name)}, "seq")`,
    ].join(', ')}) STRICT`;
  }

  // The relations that a copy of the pipeline must not make.
  get names(): readonly string[] {
    return [this.#view.name, this.#name];
  }

  get view(): SQLiteView {
    return {
      name: this.#view.name,
      description: this.#view.description,
      columns: Object.fromEntries(
        this.#view.columns.map(({ name, description }) => [name, description]),
      ),
      query: `SELECT ${this.#columns.map(quote).join(', ')} FROM ${quote(this.#name)}`,
    };
  }

  // Makes the history with the table.
  create(database: DatabaseSync): void {
    this.#history.create(database, this.#written);
  }

  // Before a new declaration replaces the table, the history keeps each of
  // its rows.
  keepAll(database: DatabaseSync, commit: () => number): void {
    if (
      database.prepare(`SELECT 1 FROM ${quote(this.#name)} LIMIT 1`).get() ===
      undefined
    )
      return;
    this.create(database);
    this.#history.keep(
      database,
      commit(),
      `FROM ${quote(this.#name)} AS "_elt_old"`,
    );
  }

  // Writes the parts of key in place of its stored parts, by seq: a part
  // with the row hash of the stored part keeps its commit, another part is
  // written in the commit that commit numbers, and each stored part beyond
  // the new parts is deleted. The history keeps each part it replaces or
  // deletes. A key with no parts keeps none.
  write(
    database: DatabaseSync,
    commit: () => number,
    key: string,
    parts: readonly PartRow[],
  ): void {
    const table = quote(this.#name);
    const keyColumn = quote(this.#key);
    const stored = new Map(
      database
        .prepare(
          `SELECT "seq", "_elt_row_hash" AS "hash" FROM ${table} WHERE ${keyColumn} = ?`,
        )
        .all(key)
        .map(({ seq, hash }) => [Number(seq), String(hash)]),
    );
    const written = this.#written;
    const upsert = database.prepare(
      `INSERT INTO ${table} (${written.join(', ')}) VALUES (${written.map(() => '?').join(', ')}) ON CONFLICT (${keyColumn}, "seq") DO UPDATE SET ${written
        .slice(2)
        .map((column) => `${column} = excluded.${column}`)
        .join(', ')}`,
    );
    const ruleColumns = this.#columns.slice(3);
    const hashed = this.#columns.map((name) => ({ name }));
    for (const [seq, part] of parts.entries()) {
      const row = [
        key,
        seq,
        part.partHash,
        ...ruleColumns.map((column) => ruleValue(part.values[column])),
      ];
      const hash = rowHash(hashed, row);
      const before = stored.get(seq);
      if (before === hash) continue;
      const number = commit();
      if (before !== undefined)
        this.#history.keep(
          database,
          number,
          `FROM ${table} AS "_elt_old" WHERE "_elt_old".${keyColumn} = ? AND "_elt_old"."seq" = ?`,
          [key, seq],
        );
      upsert.run(...row, number, hash);
    }
    if (!stored.keys().some((seq) => seq >= parts.length)) return;
    const beyond = (alias: string) =>
      `WHERE ${alias}${keyColumn} = ? AND ${alias}"seq" >= ?`;
    this.#history.keep(
      database,
      commit(),
      `FROM ${table} AS "_elt_old" ${beyond('"_elt_old".')}`,
      [key, parts.length],
    );
    database
      .prepare(`DELETE FROM ${table} ${beyond('')}`)
      .run(key, parts.length);
  }

  // The quoted columns that each row holds.
  get #written(): string[] {
    return [...this.#columns, 'committed_in', '_elt_row_hash'].map(quote);
  }
}
