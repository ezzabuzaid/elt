import { hash } from 'node:crypto';

import { Lock } from '@zukhruf/async';
import postgres from 'postgres';

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

import { identifier, quote } from './identifier.ts';
import { TargetComments } from './postgres-comments.ts';
import { rebindDependents } from './postgres-dependents.ts';
import { PostgresDerivedStatus } from './postgres-derived-status.ts';
import { PostgresDestination } from './postgres-destination.ts';
import { storedColumns } from './postgres-fit.ts';
import { TargetHistory, rowHash } from './postgres-history.ts';
import { identifiers, rawTable } from './postgres-identifiers.ts';
import { type PostgresIndex, TableIndexes } from './postgres-indexes.ts';
import { PostgresLoad, type Transaction } from './postgres-load.ts';
import { PostgresPartsTable } from './postgres-parts-table.ts';
import { TargetReaderView } from './postgres-reader-view.ts';
import { ruleColumnType, ruleValue } from './postgres-rule-columns.ts';
import { inMarts, inWarehouse, marts, warehouse } from './postgres-schemas.ts';
import { makeSchema } from './postgres-session.ts';
import { PostgresSetupError } from './postgres-setup-error.ts';
import type { PostgresTable } from './postgres-table.ts';
import { View, made } from './view.ts';

// A table of the dataset as its declaration makes it, with its history and
// the view readers query.
type DeclaredTable = Pick<
  PostgresPartsTable,
  'table' | 'declared' | 'statement' | 'history' | 'view'
>;

// Data computed on write from what the pipeline's copies load into one
// Postgres database: a rule makes one output row for each input, such as the
// text of each stored file, as pgai's vectorizer keeps an embedding beside
// each row. The pipeline refreshes it as its copies commit; each refresh
// makes the rows whose input or rule changed and deletes the rows whose
// input is gone, and a refresh after the passes also tries failed rows
// again; the passes try each input at most once, so a failing rule is asked
// once a pass.
// A rule's failure on one input is that row's; it never fails the load.
// Readers query the view name in marts, over the table raw_<name> in
// _warehouse, which a refresh makes again when its declaration changes,
// since it is rebuilt from the inputs.
// A refresh is a load of the database: each of its transactions that changes
// a row is a numbered commit, each row names the commit that last wrote it,
// and the history keeps each row a commit replaced or removed, so the view
// reads as of a position as the copies' reader views do.
// A table rule gives many parts for one input: the dataset keeps one output
// row for each key in raw_<name>, with no rule column, and its parts in
// raw_<name>_parts, which readers query through the view <name>_parts. The
// commit that writes an output row writes its parts, and the two tables are
// one declaration, so a change to either makes both again.
// A vector column is the vector type of pgvector. The first make of a table
// with one, in a database with no type vector (SQLSTATE 42704), runs CREATE
// EXTENSION IF NOT EXISTS vector and makes the table again, unless the
// destination may not create the extension, or the server has no pgvector
// to create it from (0A000): then the dataset fails with a
// PostgresSetupError. A role that may not create it fails the dataset with
// SQLSTATE 42501; both are of failure type config.
// indexes declares the indexes of raw_<name>, which each refresh brings in
// place, in the transaction that makes the tables (elt-sqlserver ADR 0013).
export class ComputedDataset<Input> extends DerivedDataset<PostgresTable> {
  readonly name: string;
  // The database the dataset lives in.
  readonly into: PostgresDestination;
  readonly #from: readonly (PostgresTable | View)[];
  readonly #compute:
    | { readonly rule: Rule<Input, RuleColumns> }
    | {
        readonly rule: TableRule<Input, RuleColumns, RuleColumns>;
        readonly parts: PostgresPartsTable;
      };
  readonly #table: string;
  readonly #output: DeclaredTable;
  // The rule columns of an output row: none for a table rule, whose columns
  // are the parts'.
  readonly #ruleColumns: RuleColumns;
  readonly #indexes: TableIndexes;
  // Whether a table of the dataset has a vector column, so a missing type
  // is the type vector of pgvector.
  readonly #vectors: boolean;

  constructor({
    into,
    name,
    description,
    from,
    compute,
    indexes = [],
  }: {
    into: PostgresDestination;
    name: string;
    description: string;
    from: readonly (PostgresTable | View)[];
    compute:
      Rule<Input, RuleColumns> | TableRule<Input, RuleColumns, RuleColumns>;
    indexes?: readonly PostgresIndex[];
  }) {
    super();
    this.name = identifier(name, 'computed dataset name');
    this.into = into;
    this.#from = Object.freeze([...from]);
    this.#compute =
      compute instanceof TableRule
        ? {
            rule: compute,
            parts: new PostgresPartsTable({
              dataset: name,
              description,
              rule: compute,
            }),
          }
        : { rule: compute };
    this.#ruleColumns = compute instanceof TableRule ? {} : compute.output;
    this.#table = rawTable(this.name);
    const keyName = identifier(compute.key.name, 'rule key name');
    // A name Postgres cannot hold is refused before it is compared.
    refuseTakenColumns({
      dataset: name,
      rule: compute,
      reserved: reservedColumns(compute),
      key: (column) => identifiers.key(identifier(column, 'rule column name')),
    });
    const declared = Object.freeze([
      {
        name: keyName,
        type: 'text',
        constraint: ' PRIMARY KEY',
      },
      ...Object.keys(computedColumns).map((column) => ({
        name: column,
        type: 'text',
        constraint: column === 'error' ? '' : ' NOT NULL',
      })),
      ...Object.entries(this.#ruleColumns).map(([column, declared]) => ({
        name: column,
        type: ruleColumnType(declared),
        constraint: '',
      })),
      { name: 'committed_in', type: 'integer', constraint: ' NOT NULL' },
      { name: '_elt_row_hash', type: 'text', constraint: ' NOT NULL' },
    ]);
    const table = inWarehouse(this.#table);
    this.#indexes = new TableIndexes({
      dataset: name,
      table,
      columns: declared,
      indexes,
    });
    this.#vectors = Object.values(
      compute instanceof TableRule
        ? { ...compute.output, ...compute.place }
        : compute.output,
    ).some(({ type }) => type === 'vector');
    const history = new TargetHistory(hash('sha256', table).slice(0, 40));
    this.#output = Object.freeze({
      table,
      declared,
      statement: `CREATE TABLE ${table} (${declared
        .map(
          ({ name, type, constraint }) => `${quote(name)} ${type}${constraint}`,
        )
        .join(', ')}, CHECK ("status" IN ('computed', 'empty', 'failed')))`,
      history,
      view: new TargetReaderView(
        this.name,
        table,
        history.qualifiedName,
        this.#columns,
        new TargetComments(description, {
          [compute.key.name]: compute.key.description,
          ...computedColumns,
          ...Object.fromEntries(
            Object.entries(this.#ruleColumns).map(
              ([column, { description }]) => [column, description],
            ),
          ),
        }),
      ),
    });
    Object.freeze(this);
  }

  // The view readers query.
  get qualifiedName(): string {
    return `${marts}.${this.name}`;
  }

  // The key, the engine columns and the rule's, which readers see.
  get #columns(): string[] {
    return [
      this.#compute.rule.key.name,
      ...Object.keys(computedColumns),
      ...Object.keys(this.#ruleColumns),
    ];
  }

  // The tables of the dataset, which one declaration makes.
  get #tables(): readonly DeclaredTable[] {
    return 'parts' in this.#compute
      ? [this.#output, this.#compute.parts]
      : [this.#output];
  }

  override validate(connections: readonly Connection<PostgresTable>[]): void {
    for (const target of this.#from)
      if (
        !(target instanceof View) &&
        this.#source(connections, target) === undefined
      )
        throw new TypeError(
          `Computed dataset ${this.name} reads ${target.name}, which no copy of the pipeline loads`,
        );
    const relations = made(connections, this.into);
    for (const relation of [
      this.qualifiedName,
      `${warehouse}.${this.#table}`,
      ...('parts' in this.#compute ? this.#compute.parts.names : []),
    ])
      if (relations.has(relation))
        throw new TypeError(
          `Computed dataset ${this.name} needs ${relation}, which a copy of the pipeline makes`,
        );
  }

  override async refresh({
    connections,
    clock,
    signal,
    trigger,
  }: {
    readonly connections: readonly Connection<PostgresTable>[];
    readonly clock: PipelineClock;
    readonly signal?: AbortSignal;
    readonly trigger: RefreshTrigger;
  }): Promise<void> {
    // Open from the start, so it closes a refresh that a process ended; with
    // no commit it is no span, and leaves the positions as they are.
    await using load = await PostgresLoad.open(
      this.into.url,
      { dataset: this.name },
      { clock, retention: this.into.retention },
    );
    const status = new PostgresDerivedStatus(
      load.sql,
      this.qualifiedName,
      'computed',
      clock,
    );
    const refresh = {
      inputs: () => this.#inputs(load.sql, connections),
      prepare: (keys: ReadonlySet<string>) =>
        this.#prepare(load, status, keys, signal),
      status,
      trigger,
      signal,
    };
    const { rule } = this.#compute;
    await (rule instanceof TableRule
      ? refreshComputed({ ...refresh, rule })
      : refreshComputed({ ...refresh, rule }));
  }

  // Makes marts, brings the tables to their declaration, removes the
  // rows whose key has no input, and gives the output table to write. Each
  // transaction takes the number of its commit at its first change, so one
  // that changes no row takes none. The load has one session, so the commits
  // of the calls take turns.
  async #prepare(
    load: PostgresLoad,
    status: PostgresDerivedStatus,
    keys: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PreparedOutputs<OutputRow | TableOutputRow>> {
    const key = quote(this.#compute.rule.key.name);
    const parts = 'parts' in this.#compute ? this.#compute.parts : undefined;
    const { table, history } = this.#output;
    const commits = (sql: Transaction) => {
      let number: Promise<number> | undefined;
      return () => (number ??= load.number(sql));
    };
    await makeSchema(load.sql, marts);
    const stored = await load.transaction(async (sql) => {
      const commit = commits(sql);
      await this.#declare(sql, commit);
      await this.#indexes.reconcile(sql);
      const rows = new Map<string, StoredOutput>();
      const gone: string[] = [];
      for (const row of await sql.unsafe<
        { key: string; input_hash: string; rule: string; status: string }[]
      >(`SELECT ${key} AS "key", "input_hash", "rule", "status" FROM ${table}`))
        if (keys.has(row.key))
          rows.set(row.key, {
            inputHash: row.input_hash,
            rule: row.rule,
            status: row.status,
          });
        else gone.push(row.key);
      if (gone.length > 0) {
        await history.remove(
          sql,
          await commit(),
          table,
          ` WHERE "_elt_old".${key} IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
          [JSON.stringify(gone)],
        );
        await parts?.remove(sql, await commit(), gone);
      }
      for (const declared of this.#tables) await declared.history.expire(sql);
      return rows;
    });
    const written = this.#output.declared.map(({ name }) => quote(name));
    const hashed = this.#columns.map((name) => ({ name }));
    // Writes a row in the commit that commit numbers, unless the stored row
    // has the same values: then it keeps its commit. The history keeps the
    // row it replaces. The row's parts are written in the same commit.
    const store = async (
      sql: Transaction,
      commit: () => Promise<number>,
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
      const version = rowHash(hashed, row);
      const [before] = await sql.unsafe<{ hash: string }[]>(
        `SELECT "_elt_row_hash" AS "hash" FROM ${table} WHERE ${key} = $1`,
        [output.key],
      );
      if (before?.hash !== version) {
        const number = await commit();
        if (before !== undefined)
          await history.keep(
            sql,
            number,
            table,
            `FROM ${table} AS "_elt_old" WHERE "_elt_old".${key} = $1`,
            [output.key],
          );
        await sql.unsafe(
          `INSERT INTO ${table} (${written.join(', ')}) VALUES (${written.map((_, index) => `$${index + 1}`).join(', ')}) ON CONFLICT (${key}) DO UPDATE SET ${written
            .slice(1)
            .map((column) => `${column} = excluded.${column}`)
            .join(', ')}`,
          [...row, number, version],
        );
      }
      await parts?.write(
        sql,
        commit,
        output.key,
        'parts' in output ? output.parts : [],
      );
    };
    const session = new Lock();
    const settle = (work: (sql: Transaction) => Promise<void>) =>
      session.run(() => load.transaction(work), { signal });
    return {
      stored,
      store: (output) => settle((sql) => store(sql, commits(sql), output)),
      settle: (outputs, settled) =>
        settle(async (sql) => {
          const commit = commits(sql);
          for (const output of outputs) await store(sql, commit, output);
          await status.settled(sql, settled);
        }),
      counts: async () =>
        new Map(
          (
            await load.sql.unsafe<{ status: string; n: number }[]>(
              `SELECT "status", count(*)::int AS "n" FROM ${table} GROUP BY "status"`,
            )
          ).map(({ status, n }) => [status, n]),
        ),
    };
  }

  // Makes the tables, their histories and their views, or makes every table
  // again when the stored columns of one differ from its declaration: the
  // history of each keeps each row of its old table, in a commit, and the
  // views over the old tables read the new ones.
  async #declare(
    sql: Transaction,
    commit: () => Promise<number>,
  ): Promise<void> {
    const tables = this.#tables;
    const stored: { name: string; type: string }[][] = [];
    for (const { table } of tables)
      stored.push(await storedColumns(sql, table));
    const missing = stored.every((columns) => columns.length === 0);
    const fits = tables.every(
      ({ declared }, index) =>
        stored[index]?.length === declared.length &&
        stored[index].every(
          ({ name, type }, column) =>
            declared[column]?.name === name && declared[column]?.type === type,
        ),
    );
    if (missing || fits) {
      for (const { table, statement, history, view } of tables) {
        if (missing) await this.#make(sql, statement);
        await history.create(sql, table, commit);
        await view.describe(sql);
      }
      return;
    }
    for (const [index, { table, history }] of tables.entries()) {
      if (stored[index]?.length === 0) continue;
      const [kept] = await sql.unsafe(`SELECT 1 FROM ${table} LIMIT 1`);
      if (kept === undefined) continue;
      await history.create(sql, table, commit);
      await history.keep(
        sql,
        await commit(),
        table,
        `FROM ${table} AS "_elt_old"`,
      );
    }
    await rebindDependents(
      sql,
      tables.flatMap(({ table, history, view }) => [
        table,
        history.qualifiedName,
        view.qualifiedName,
      ]),
      async () => {
        for (const { table, view } of tables) {
          await view.drop(sql);
          await sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
        }
        for (const { table, statement, history, view } of tables) {
          await this.#make(sql, statement);
          await history.create(sql, table, commit);
          await view.describe(sql);
        }
      },
    );
  }

  // Makes a table of the dataset. When the table has a vector column and the
  // database has no type vector (42704), it creates the extension of
  // pgvector and makes the table again, or fails with a PostgresSetupError
  // when the destination may not create it, or when the server has no
  // pgvector to create it from (0A000). A savepoint keeps the transaction
  // usable after the first try fails.
  async #make(sql: Transaction, statement: string): Promise<void> {
    if (!this.#vectors) {
      await sql.unsafe(statement);
      return;
    }
    await sql.unsafe('SAVEPOINT elt_make');
    try {
      await sql.unsafe(statement);
      await sql.unsafe('RELEASE SAVEPOINT elt_make');
      return;
    } catch (error) {
      if (!(error instanceof postgres.PostgresError && error.code === '42704'))
        throw error;
      await sql.unsafe('ROLLBACK TO SAVEPOINT elt_make');
      if (!this.into.createExtension)
        throw new PostgresSetupError(
          `Computed dataset ${this.name} has a vector column, and the database has no type vector: run CREATE EXTENSION vector in it, or let the PostgresDestination create it (createExtension: true)`,
          { cause: error },
        );
    }
    try {
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS vector');
    } catch (error) {
      if (!(error instanceof postgres.PostgresError && error.code === '0A000'))
        throw error;
      throw new PostgresSetupError(
        `Computed dataset ${this.name} has a vector column, and the server has no pgvector to create the extension vector from: install pgvector on the server`,
        { cause: error },
      );
    }
    await sql.unsafe(statement);
  }

  // Each input by key, from the rows of each relation of from that exists
  // yet: what the copies loaded, through its reader view, or what a view
  // before this dataset gives. A key read twice keeps its first
  // input.
  // null while a relation reads a table that is gone, such as one a person
  // dropped by hand: its copy loads it again, and the dataset waits with what
  // it made, as a view waits. Read as no rows, it would delete every output,
  // and the reload would pay the rule for each again.
  async #inputs(
    sql: postgres.Sql,
    connections: readonly Connection<PostgresTable>[],
  ): Promise<Map<string, Input> | null> {
    const inputs = new Map<string, Input>();
    for (const target of this.#from) {
      const relation =
        target instanceof View
          ? inMarts(target.name)
          : this.#loaded(connections, target);
      if (relation === undefined) continue;
      const [exists] = await sql.unsafe(
        'SELECT to_regclass($1) IS NOT NULL AS "exists"',
        [relation],
      );
      if (exists?.exists !== true) {
        if (target instanceof View) continue;
        return null;
      }
      for await (const rows of sql
        .unsafe(`SELECT * FROM ${relation}`)
        .cursor(1000))
        for (const row of rows) {
          const read = this.#compute.rule.read(row);
          if (read !== null && !inputs.has(read.key))
            inputs.set(read.key, read.input);
        }
    }
    return inputs;
  }

  // The reader view of a target a copy of the pipeline loads; undefined
  // while no copy of the pipeline loads it into a Postgres database.
  #loaded(
    connections: readonly Connection<PostgresTable>[],
    target: PostgresTable,
  ): string | undefined {
    return this.#source(connections, target) === undefined
      ? undefined
      : inMarts(target.name);
  }

  // The destination of the copy of the pipeline that loads target.
  #source(
    connections: readonly Connection<PostgresTable>[],
    target: PostgresTable,
  ): PostgresDestination | undefined {
    const connection = connections.find(({ steps }) =>
      steps.some(({ to }) => to === target),
    );
    return connection?.destination instanceof PostgresDestination
      ? connection.destination
      : undefined;
  }
}
