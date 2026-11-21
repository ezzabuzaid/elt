import { hash } from 'node:crypto';

import {
  type OutputRow,
  type RuleColumns,
  type TableOutputRow,
  type TableRule,
  partsView,
} from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { TargetDescriptions } from './sql-server-descriptions.ts';
import { TargetHistory, rowHash } from './sql-server-history.ts';
import { quote, rawTable } from './sql-server-identifiers.ts';
import { type SqlServerIndex, TableIndexes } from './sql-server-indexes.ts';
import { TargetReaderView } from './sql-server-reader-view.ts';
import {
  type Declared,
  batchValue,
  keyHash,
  ruleBatchType,
  ruleColumnType,
  ruleStored,
  storedValue,
} from './sql-server-rule-columns.ts';
import { inWarehouse, marts, warehouse } from './sql-server-schemas.ts';

// The parts of a computed dataset whose rule is a table rule, in the table
// raw_<name>_parts of _warehouse beside the output rows of raw_<name>, as in
// elt-postgresql: one row for each part, with the content columns and the
// place columns of the rule. Readers query the view <name>_parts of marts.
// The table numbers its rows with _elt_row, its clustered key (ADR 0003),
// and is unique on the key hash and seq (ADR 0004). Each row names the
// commit that last wrote it, and the history keeps each row that a commit
// replaced or removed, as for the output rows.
export class SqlServerPartsTable {
  readonly table: string;
  readonly declared: readonly Declared[];
  readonly statement: string;
  readonly history: TargetHistory;
  readonly view: TargetReaderView;
  readonly indexes: TableIndexes;
  // The relations that a copy of the pipeline must not make.
  readonly names: readonly string[];
  readonly #key: string;
  readonly #rule: Pick<
    TableRule<unknown, RuleColumns, RuleColumns>,
    'output' | 'place'
  >;
  // Every column of a part that readers see and the row hash counts, in
  // table order.
  readonly #columns: readonly string[];

  constructor({
    dataset,
    description,
    rule,
    indexes,
  }: {
    dataset: string;
    description: string;
    rule: Pick<
      TableRule<unknown, RuleColumns, RuleColumns>,
      'key' | 'output' | 'place'
    >;
    indexes: readonly SqlServerIndex[];
  }) {
    const view = partsView({ dataset, description, rule });
    const name = rawTable(view.name);
    this.names = Object.freeze([
      `${marts}.${view.name}`,
      `${warehouse}.${name}`,
    ]);
    this.table = inWarehouse(name);
    this.#key = rule.key.name;
    this.#rule = rule;
    this.#columns = Object.freeze(view.columns.map(({ name }) => name));
    this.declared = Object.freeze([
      { name: '_elt_row', type: 'bigint', required: true },
      { name: rule.key.name, type: 'nvarchar(max)', required: true },
      { name: 'seq', type: 'int', required: true },
      { name: 'part_hash', type: 'nvarchar(max)', required: true },
      ...Object.entries({ ...rule.output, ...rule.place }).map(
        ([column, ruleColumn]) => ({
          name: column,
          type: ruleColumnType(column, ruleColumn),
          required: false,
        }),
      ),
      { name: 'committed_in', type: 'bigint', required: true },
      { name: '_elt_row_hash', type: 'binary(32)', required: true },
      { name: '_elt_key_hash', type: 'binary(32)', required: true },
    ]);
    const columns = this.declared
      .slice(1)
      .map(
        ({ name, type, required }) =>
          `${quote(name)} ${type} ${required ? 'NOT NULL' : 'NULL'}`,
      );
    this.statement = `CREATE TABLE ${this.table} ([_elt_row] bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY CLUSTERED, ${columns.join(', ')});
      CREATE UNIQUE INDEX [key_hash_seq] ON ${this.table} ([_elt_key_hash], [seq]);`;
    this.indexes = new TableIndexes({
      dataset,
      table: this.table,
      columns: this.declared,
      indexes,
    });
    this.history = new TargetHistory(hash('sha256', this.table).slice(0, 40));
    this.view = new TargetReaderView(
      view.name,
      this.table,
      this.history.qualifiedName,
      this.#columns,
      new TargetDescriptions(
        view.description,
        Object.fromEntries(
          view.columns.map((column) => [column.name, column.description]),
        ),
      ),
    );
    Object.freeze(this);
  }

  // Writes the parts of each output row in place of its stored parts, by
  // seq, in the commit that commit numbers: a part with the row hash of the
  // stored part keeps its commit, the other parts are written in one MERGE,
  // and each stored part beyond the new parts of its row is deleted. The
  // history keeps each part that the commit replaces or deletes. A row with
  // no parts, empty or failed, keeps none.
  async write(
    connection: SqlServerConnection,
    commit: () => Promise<number>,
    outputs: readonly (OutputRow | TableOutputRow)[],
  ): Promise<void> {
    const ruleColumns = Object.entries({
      ...this.#rule.output,
      ...this.#rule.place,
    });
    const hashed = this.#columns.map((name) => ({ name }));
    const rows = outputs.map((output) => {
      const key = keyHash(output.key);
      const parts = 'parts' in output ? output.parts : [];
      return {
        key,
        count: parts.length,
        parts: parts.map((part, seq) => {
          const values = [
            output.key,
            seq,
            part.partHash,
            ...ruleColumns.map(([column]) => storedValue(part.values[column])),
          ];
          return { key, seq, version: rowHash(hashed, values), values };
        }),
      };
    });
    const stored = Map.groupBy(
      (
        await connection.query(
          `SELECT LOWER(CONVERT(char(64), [_elt_key_hash], 2)) AS [key], [seq], LOWER(CONVERT(char(64), [_elt_row_hash], 2)) AS [version]
           FROM ${this.table} WHERE [_elt_key_hash] IN (SELECT CONVERT(binary(32), [value], 2) FROM OPENJSON(@keys))`,
          { keys: JSON.stringify(rows.map(({ key }) => key)) },
        )
      ).map(({ key, seq, version }) => ({
        key: String(key),
        seq: Number(seq),
        version: String(version),
      })),
      ({ key }) => key,
    );
    const changed = rows
      .flatMap(({ parts }) => parts)
      .filter(
        (part) =>
          stored.get(part.key)?.find(({ seq }) => seq === part.seq)?.version !==
          part.version,
      );
    if (changed.length > 0) await this.#merge(connection, commit, changed);
    if (
      rows.some(({ key, count }) =>
        stored.get(key)?.some(({ seq }) => seq >= count),
      )
    )
      await this.history.remove(
        connection,
        await commit(),
        this.table,
        `EXISTS (SELECT 1 FROM OPENJSON(@counts) WITH ([k] char(64) '$[0]', [n] int '$[1]') AS c WHERE [_elt_key_hash] = CONVERT(binary(32), c.[k], 2) AND [seq] >= c.[n])`,
        { counts: JSON.stringify(rows.map(({ key, count }) => [key, count])) },
      );
  }

  // Deletes every part of the keys whose key hashes are given, in the commit
  // replacedIn, and the history keeps them.
  async remove(
    connection: SqlServerConnection,
    replacedIn: number,
    keyHashes: readonly string[],
  ): Promise<void> {
    await this.history.remove(
      connection,
      replacedIn,
      this.table,
      '[_elt_key_hash] IN (SELECT CONVERT(binary(32), [value], 2) FROM OPENJSON(@gone))',
      { gone: JSON.stringify(keyHashes) },
    );
  }

  // One MERGE on the key hash and seq of the changed parts, from OPENJSON of
  // their values, whose output the history keeps (ADR 0005, 0011).
  async #merge(
    connection: SqlServerConnection,
    commit: () => Promise<number>,
    changed: readonly {
      readonly key: string;
      readonly version: string;
      readonly values: readonly (string | number | Uint8Array | null)[];
    }[],
  ): Promise<void> {
    // Each column as OPENJSON reads it and as the table stores it.
    const same = (at: string) => at;
    const fields = [
      { name: this.#key, type: 'nvarchar(max)', stored: same },
      { name: 'seq', type: 'int', stored: same },
      { name: 'part_hash', type: 'nvarchar(max)', stored: same },
      ...Object.entries({ ...this.#rule.output, ...this.#rule.place }).map(
        ([name, column]) => ({
          name,
          type: ruleBatchType(column),
          stored: (at: string) => ruleStored(name, column, at),
        }),
      ),
    ];
    const written = [
      ...fields.map(({ name }) => name),
      'committed_in',
      '_elt_row_hash',
      '_elt_key_hash',
    ].map(quote);
    const source = `SELECT ${[
      ...fields.map(
        ({ name, stored }, index) =>
          `${stored(`j.[v${index}]`)} AS ${quote(name)}`,
      ),
      'CAST(@committed AS bigint) AS [committed_in]',
      'CONVERT(binary(32), j.[h], 2) AS [_elt_row_hash]',
      'CONVERT(binary(32), j.[k], 2) AS [_elt_key_hash]',
    ].join(', ')} FROM OPENJSON(@batch) WITH (${[
      `[k] char(64) '$[0]'`,
      `[h] char(64) '$[1]'`,
      ...fields.map(
        ({ type }, index) => `[v${index}] ${type} '$[${index + 2}]'`,
      ),
    ].join(', ')}) AS j`;
    const committed = await commit();
    await this.history.keep(
      connection,
      committed,
      this.table,
      `MERGE ${this.table} AS t USING (${source}) AS s ON t.[_elt_key_hash] = s.[_elt_key_hash] AND t.[seq] = s.[seq]
       WHEN MATCHED THEN UPDATE SET ${written.map((column) => `t.${column} = s.${column}`).join(', ')}
       WHEN NOT MATCHED THEN INSERT (${written.join(', ')}) VALUES (${written.map((column) => `s.${column}`).join(', ')})
       OUTPUT deleted.*`,
      {
        committed: String(committed),
        batch: JSON.stringify(
          changed.map((part) => [
            part.key,
            part.version,
            ...part.values.map(batchValue),
          ]),
        ),
      },
    );
  }
}
