import type { SQLOutputValue } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';
import { open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import {
  type Connection,
  DerivedDataset,
  type OutputRow,
  type PipelineClock,
  type PreparedOutputs,
  type RefreshTrigger,
  type Rule,
  type RuleColumns,
  type StoredOutput,
  type TableOutputRow,
  TableRule,
  computedColumns,
  refreshComputed,
  refuseTakenColumns,
  reservedColumns,
} from '@eltjs/elt';

import { busyTimeout } from './open-destination.ts';
import { SQLiteDerivedStatus } from './sqlite-derived-status.ts';
import { SQLiteDestination } from './sqlite-destination.ts';
import { SQLiteHistory, rowHash } from './sqlite-history.ts';
import { identifiers, quote, rawTable } from './sqlite-identifiers.ts';
import { SQLiteLoad } from './sqlite-loads.ts';
import { SQLitePartsTable } from './sqlite-parts-table.ts';
import { ruleColumnTypes, ruleValue } from './sqlite-rule-columns.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { publishSQLiteViews } from './sqlite-views.ts';
import { View } from './view.ts';

// Data computed on write from what the pipeline's copies load: a rule makes
// one output row for each input, such as the text of each stored file, as
// pgai's vectorizer keeps an embedding beside each row. The pipeline refreshes
// it as its copies commit; each refresh makes the rows whose input or rule
// changed and deletes the rows whose input is gone, and a refresh after the
// passes also tries failed rows again; the passes try each input at most
// once, so a failing rule is asked once a pass.
// A rule's failure on one input is that row's; it never fails the load.
// Readers query the view name, over the table raw_<name>, which a refresh
// replaces when its declaration changes, since it is rebuilt from the inputs.
// A refresh is a load of the file: each of its transactions that changes a
// row is a numbered commit, each row names the commit that last wrote it,
// and the history keeps each row a commit replaced or removed, so the view
// reads as of a position as the copies' tables do.
// A table rule gives many parts for one input: the dataset keeps one output
// row for each key in raw_<name>, with no rule column, and its parts in
// raw_<name>_parts, which readers query through the view <name>_parts. The
// commit that writes an output row writes its parts, and the two tables are
// one declaration, so a change to either makes both again.
export class ComputedDataset<Input> extends DerivedDataset<SQLiteTable> {
  readonly name: string;
  readonly #into: SQLiteDestination;
  readonly #description: string;
  readonly #from: readonly (SQLiteTable | View)[];
  readonly #compute:
    | { readonly rule: Rule<Input, RuleColumns> }
    | {
        readonly rule: TableRule<Input, RuleColumns, RuleColumns>;
        readonly parts: SQLitePartsTable;
      };
  readonly #table: string;
  readonly #declaration: Declaration;
  readonly #history: SQLiteHistory;
  // Every column of an output row, in table order.
  readonly #columns: readonly string[];
  // The rule columns of an output row: none for a table rule, whose columns
  // are the parts'.
  readonly #ruleColumns: RuleColumns;

  constructor({
    into,
    name,
    description,
    from,
    compute,
  }: {
    into: SQLiteDestination;
    name: string;
    description: string;
    from: readonly (SQLiteTable | View)[];
    compute:
      Rule<Input, RuleColumns> | TableRule<Input, RuleColumns, RuleColumns>;
  }) {
    super();
    this.name = name;
    this.#into = into;
    this.#description = description;
    this.#from = Object.freeze([...from]);
    this.#compute =
      compute instanceof TableRule
        ? {
            rule: compute,
            parts: new SQLitePartsTable({
              dataset: name,
              description,
              rule: compute,
            }),
          }
        : { rule: compute };
    this.#ruleColumns = compute instanceof TableRule ? {} : compute.output;
    this.#table = rawTable(name);
    this.#history = new SQLiteHistory({
      raw: this.#table,
      location: identifiers.key(this.#table),
    });
    // SQLite takes two names that differ only in ASCII case for one column,
    // and would refuse the table at the first refresh.
    refuseTakenColumns({
      dataset: name,
      rule: compute,
      reserved: reservedColumns(compute),
      key: (column) => identifiers.key(column),
    });
    this.#columns = Object.freeze([
      compute.key.name,
      ...Object.keys(computedColumns),
      ...Object.keys(this.#ruleColumns),
    ]);
    const ruleColumns = Object.entries(this.#ruleColumns).map(
      ([column, { type }]) => `${quote(column)} ${ruleColumnTypes[type]}`,
    );
    this.#declaration = new Declaration(
      [
        `CREATE TABLE ${quote(this.#table)} (${[
          `${quote(compute.key.name)} TEXT PRIMARY KEY`,
          '"input_hash" TEXT NOT NULL',
          '"rule" TEXT NOT NULL',
          `"status" TEXT NOT NULL CHECK ("status" IN ('computed', 'empty', 'failed'))`,
          '"error" TEXT',
          ...ruleColumns,
          '"committed_in" INTEGER NOT NULL',
          '"_elt_row_hash" TEXT NOT NULL',
        ].join(', ')}) STRICT`,
        ...('parts' in this.#compute ? [this.#compute.parts.statement] : []),
      ],
      { rows: 'replace' },
    );
    Object.freeze(this);
  }

  override validate(connections: readonly Connection<SQLiteTable>[]): void {
    for (const target of this.#from)
      if (
        !(target instanceof View) &&
        this.#source(connections, target) === undefined
      )
        throw new TypeError(
          `Computed dataset ${this.name} reads ${target.name}, which no copy of the pipeline loads`,
        );
    const made = connections
      .filter(({ destination }) => this.#same(destination))
      .flatMap(({ steps }) => steps)
      .flatMap(({ to }) => [to.name, to.raw])
      .map((name) => name.toLowerCase());
    for (const name of [
      this.name,
      this.#table,
      ...('parts' in this.#compute ? this.#compute.parts.names : []),
    ])
      if (made.includes(name.toLowerCase()))
        throw new TypeError(
          `Computed dataset ${this.name} needs ${name}, which a copy of the pipeline makes`,
        );
  }

  override async refresh({
    connections,
    clock,
    signal,
    trigger,
  }: {
    readonly connections: readonly Connection<SQLiteTable>[];
    readonly clock: PipelineClock;
    readonly signal?: AbortSignal;
    readonly trigger: RefreshTrigger;
  }): Promise<void> {
    // Open from the start, so it closes a refresh that a process ended; with
    // no commit it is no span, and leaves the positions as they are.
    using load = SQLiteLoad.open(
      this.#into.path,
      { dataset: this.name },
      { clock, retention: this.#into.retention },
    );
    const status = new SQLiteDerivedStatus(
      load.database,
      this.name,
      'computed',
      clock,
    );
    const refresh = {
      inputs: async () => this.#inputs(connections),
      prepare: async (keys: ReadonlySet<string>) =>
        this.#prepare(load, status, keys),
      status,
      trigger,
      signal,
    };
    const { rule } = this.#compute;
    await (rule instanceof TableRule
      ? refreshComputed({ ...refresh, rule })
      : refreshComputed({ ...refresh, rule }));
  }

  // Brings the table to its declaration, in the commit that keeps each row a
  // new declaration drops in the history, removes the rows whose key has no
  // input, and gives the output table to write. Each transaction takes the
  // number of its commit at its first change, so one that changes no row
  // takes none.
  #prepare(
    load: SQLiteLoad,
    status: SQLiteDerivedStatus,
    keys: ReadonlySet<string>,
  ): PreparedOutputs<OutputRow | TableOutputRow> {
    const { database } = load;
    const { rule } = this.#compute;
    const key = rule.key.name;
    const parts = 'parts' in this.#compute ? this.#compute.parts : undefined;
    const table = quote(this.#table);
    const byKey = `FROM ${table} AS "_elt_old" WHERE "_elt_old".${quote(key)} = ?`;
    const commits = () => {
      let number: number | undefined;
      return () => (number ??= load.commit());
    };
    const written = [...this.#columns, 'committed_in', '_elt_row_hash'].map(
      quote,
    );
    const stored = transaction(
      database,
      () => {
        const commit = commits();
        // A new declaration replaces the tables, and the history keeps the
        // rows it drops.
        if (this.#declaration.drift(database) === 'stale') {
          if (
            database.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !==
            undefined
          ) {
            this.#history.create(database, written);
            this.#history.keep(
              database,
              commit(),
              `FROM ${table} AS "_elt_old"`,
            );
          }
          parts?.keepAll(database, commit);
        }
        this.#declaration.apply(database);
        this.#history.create(database, written);
        parts?.create(database);
        publishSQLiteViews(database, {
          views: [
            {
              name: this.name,
              description: this.#description,
              columns: {
                [key]: rule.key.description,
                ...computedColumns,
                ...Object.fromEntries(
                  Object.entries(this.#ruleColumns).map(
                    ([column, { description }]) => [column, description],
                  ),
                ),
              },
              query: `SELECT ${this.#columns.map(quote).join(', ')} FROM ${table}`,
            },
            ...(parts === undefined ? [] : [parts.view]),
          ],
        });
        const rows = new Map<string, StoredOutput>();
        const remove = database.prepare(
          `DELETE FROM ${table} WHERE ${quote(key)} = ?`,
        );
        for (const row of database
          .prepare(
            `SELECT ${quote(key)} AS "key", "input_hash", "rule", "status" FROM ${table}`,
          )
          .all()) {
          const id = String(row.key);
          if (!keys.has(id)) {
            this.#history.keep(database, commit(), byKey, [id]);
            remove.run(id);
            parts?.write(database, commit, id, []);
          } else
            rows.set(id, {
              inputHash: String(row.input_hash),
              rule: String(row.rule),
              status: String(row.status),
            });
        }
        return rows;
      },
      { mode: 'immediate' },
    );
    const version = database.prepare(
      `SELECT "_elt_row_hash" AS "hash" FROM ${table} WHERE ${quote(key)} = ?`,
    );
    const write = database.prepare(
      `INSERT INTO ${table} (${written.join(', ')}) VALUES (${written.map(() => '?').join(', ')}) ON CONFLICT (${quote(key)}) DO UPDATE SET ${written
        .slice(1)
        .map((column) => `${column} = excluded.${column}`)
        .join(', ')}`,
    );
    const hashed = this.#columns.map((name) => ({ name }));
    // Writes a row in the commit that commit numbers, unless the stored row
    // has the same values: then it keeps its commit. The history keeps the
    // row it replaces. The row's parts are written in the same commit.
    const store = (
      commit: () => number,
      output: OutputRow | TableOutputRow,
    ) => {
      const row = [
        output.key,
        output.inputHash,
        output.rule,
        output.status,
        output.error,
        ...Object.keys(this.#ruleColumns).map((column) =>
          ruleValue('values' in output ? output.values[column] : undefined),
        ),
      ];
      const hash = rowHash(hashed, row);
      const before = version.get(output.key)?.hash;
      if (before !== hash) {
        const number = commit();
        if (before !== undefined)
          this.#history.keep(database, number, byKey, [output.key]);
        write.run(...row, number, hash);
      }
      parts?.write(
        database,
        commit,
        output.key,
        'parts' in output ? output.parts : [],
      );
    };
    return {
      stored,
      store: async (output) => {
        transaction(database, () => store(commits(), output), {
          mode: 'immediate',
        });
      },
      settle: async (outputs, settled) => {
        transaction(
          database,
          () => {
            const commit = commits();
            for (const output of outputs) store(commit, output);
            status.settled(settled);
          },
          { mode: 'immediate' },
        );
      },
      counts: async () =>
        new Map(
          database
            .prepare(
              `SELECT "status", count(*) AS "n" FROM ${table} GROUP BY "status"`,
            )
            .all()
            .map(({ status, n }) => [String(status), Number(n)]),
        ),
    };
  }

  // Each input by key, from the rows of each relation of from that exists
  // yet: what the copies loaded, or what a view before this dataset gives. A
  // key read twice keeps its first input.
  // null while a relation reads a table that is gone, such as one a person
  // dropped by hand: its copy loads it again, and the dataset waits with what it
  // made, as a view waits. Read as no rows, it would delete every output, and the
  // reload would pay the rule for each again.
  #inputs(
    connections: readonly Connection<SQLiteTable>[],
  ): Map<string, Input> | null {
    const inputs = new Map<string, Input>();
    for (const target of this.#from) {
      const path =
        target instanceof View
          ? target.into.path
          : this.#source(connections, target);
      if (path === undefined) continue;
      using database = open(path, { readOnly: true, timeout: busyTimeout });
      if (
        database
          .prepare('SELECT 1 FROM sqlite_schema WHERE lower("name") = lower(?)')
          .get(target.name) === undefined
      )
        continue;
      let rows: Record<string, SQLOutputValue>[];
      try {
        rows = database.prepare(`SELECT * FROM ${quote(target.name)}`).all();
      } catch (error) {
        if (Error.isError(error) && error.message.startsWith('no such table: '))
          return null;
        throw error;
      }
      for (const row of rows) {
        const read = this.#compute.rule.read(row);
        if (read !== null && !inputs.has(read.key))
          inputs.set(read.key, read.input);
      }
    }
    return inputs;
  }

  // The file of the copy of the pipeline that loads target.
  #source(
    connections: readonly Connection<SQLiteTable>[],
    target: SQLiteTable,
  ): string | undefined {
    const connection = connections.find(({ steps }) =>
      steps.some(({ to }) => to === target),
    );
    return connection?.destination instanceof SQLiteDestination
      ? connection.destination.path
      : undefined;
  }

  #same(destination: unknown): boolean {
    return (
      destination instanceof SQLiteDestination &&
      destination.path === this.#into.path
    );
  }
}
