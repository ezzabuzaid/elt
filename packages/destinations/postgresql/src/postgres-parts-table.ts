import { hash } from 'node:crypto';

import {
  type PartRow,
  type RuleColumns,
  type TableRule,
  partsView,
} from '@eltjs/elt';

import { identifier, quote } from './identifier.ts';
import { TargetComments } from './postgres-comments.ts';
import { TargetHistory, rowHash } from './postgres-history.ts';
import { rawTable } from './postgres-identifiers.ts';
import { TableIndexes } from './postgres-indexes.ts';
import type { Transaction } from './postgres-load.ts';
import { TargetReaderView } from './postgres-reader-view.ts';
import { ruleColumnType, ruleValue } from './postgres-rule-columns.ts';
import { inWarehouse, marts, warehouse } from './postgres-schemas.ts';

// The parts of a computed dataset whose rule is a table rule, in the table
// raw_<name>_parts of _warehouse beside the output rows of raw_<name>: one row
// for each part, unique on the key and seq, with the content columns and the
// place columns of the rule. Readers query the view <name>_parts of marts.
// Each row names the commit that last wrote it, and the history
// keeps each row a commit replaced or removed, as for the output rows.
// An index on part_hash finds the parts of a part hash, as a computed
// dataset keyed by part hash reads them, such as the vectors of the parts'
// texts that Embedding makes: each refresh brings it in place, also on a
// parts table made before the index was declared.
export class PostgresPartsTable {
  readonly table: string;
  readonly history: TargetHistory;
  readonly view: TargetReaderView;
  // Every column of a part with its type and its constraint, in table order.
  readonly declared: readonly {
    name: string;
    type: string;
    constraint: string;
  }[];
  readonly statement: string;
  // The managed indexes of the table: the one on part_hash.
  readonly indexes: TableIndexes;
  // The relations that a copy of the pipeline must not make, qualified.
  readonly names: readonly string[];
  readonly #key: string;
  // Every column of a part that readers see, in table order.
  readonly #columns: readonly string[];

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
    const parts = partsView({ dataset, description, rule });
    const view = identifier(parts.name, 'parts view name');
    const name = rawTable(view);
    this.names = Object.freeze([`${marts}.${view}`, `${warehouse}.${name}`]);
    this.table = inWarehouse(name);
    this.#key = quote(rule.key.name);
    const ruleColumns = { ...rule.output, ...rule.place };
    this.declared = Object.freeze([
      { name: rule.key.name, type: 'text', constraint: ' NOT NULL' },
      { name: 'seq', type: 'integer', constraint: ' NOT NULL' },
      { name: 'part_hash', type: 'text', constraint: ' NOT NULL' },
      ...Object.entries(ruleColumns).map(([column, declared]) => ({
        name: column,
        type: ruleColumnType(declared),
        constraint: '',
      })),
      { name: 'committed_in', type: 'integer', constraint: ' NOT NULL' },
      { name: '_elt_row_hash', type: 'text', constraint: ' NOT NULL' },
    ]);
    this.#columns = Object.freeze(
      this.declared.slice(0, -2).map(({ name }) => name),
    );
    this.statement = `CREATE TABLE ${this.table} (${[
      ...this.declared.map(
        ({ name, type, constraint }) => `${quote(name)} ${type}${constraint}`,
      ),
      `PRIMARY KEY (${this.#key}, "seq")`,
    ].join(', ')})`;
    this.indexes = new TableIndexes({
      dataset,
      table: this.table,
      columns: this.declared,
      indexes: [{ type: 'btree', columns: ['part_hash'] }],
    });
    this.history = new TargetHistory(hash('sha256', this.table).slice(0, 40));
    this.view = new TargetReaderView(
      view,
      this.table,
      this.history.qualifiedName,
      this.#columns,
      new TargetComments(
        parts.description,
        Object.fromEntries(
          parts.columns.map((column) => [column.name, column.description]),
        ),
      ),
    );
    Object.freeze(this);
  }

  // Writes the parts of key in place of its stored parts, by seq: a part
  // with the row hash of the stored part keeps its commit, another part is
  // written in the commit that commit numbers, and each stored part beyond
  // the new parts is deleted. The history keeps each part it replaces or
  // deletes. A key with no parts keeps none.
  async write(
    sql: Transaction,
    commit: () => Promise<number>,
    key: string,
    parts: readonly PartRow[],
  ): Promise<void> {
    const stored = new Map(
      (
        await sql.unsafe<{ seq: number; hash: string }[]>(
          `SELECT "seq", "_elt_row_hash" AS "hash" FROM ${this.table} WHERE ${this.#key} = $1`,
          [key],
        )
      ).map(({ seq, hash }) => [seq, hash]),
    );
    const written = this.declared.map(({ name }) => quote(name));
    const ruleColumns = this.#columns.slice(3);
    const hashed = this.#columns.map((name) => ({ name }));
    for (const [seq, part] of parts.entries()) {
      const row = [
        key,
        seq,
        part.partHash,
        ...ruleColumns.map((column) => ruleValue(part.values[column])),
      ];
      const version = rowHash(hashed, row);
      const before = stored.get(seq);
      if (before === version) continue;
      const number = await commit();
      if (before !== undefined)
        await this.history.keep(
          sql,
          number,
          this.table,
          `FROM ${this.table} AS "_elt_old" WHERE "_elt_old".${this.#key} = $1 AND "_elt_old"."seq" = $2::integer`,
          [key, String(seq)],
        );
      await sql.unsafe(
        `INSERT INTO ${this.table} (${written.join(', ')}) VALUES (${written.map((_, index) => `$${index + 1}`).join(', ')}) ON CONFLICT (${this.#key}, "seq") DO UPDATE SET ${written
          .slice(2)
          .map((column) => `${column} = excluded.${column}`)
          .join(', ')}`,
        [...row, number, version],
      );
    }
    if (!stored.keys().some((seq) => seq >= parts.length)) return;
    await this.history.remove(
      sql,
      await commit(),
      this.table,
      ` WHERE "_elt_old".${this.#key} = $1 AND "_elt_old"."seq" >= $2::integer`,
      [key, String(parts.length)],
    );
  }

  // Deletes every part of the keys, in the commit replacedIn, and the
  // history keeps them first.
  async remove(
    sql: Transaction,
    replacedIn: number,
    keys: readonly string[],
  ): Promise<void> {
    await this.history.remove(
      sql,
      replacedIn,
      this.table,
      ` WHERE "_elt_old".${this.#key} IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
      [JSON.stringify(keys)],
    );
  }
}
