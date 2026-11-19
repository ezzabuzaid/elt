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
  type StoredOutput,
  computedColumns,
  refreshComputed,
} from '@eltjs/elt';

import { identifier, quote } from './identifier.ts';
import { TargetComments } from './postgres-comments.ts';
import { rebindDependents } from './postgres-dependents.ts';
import { PostgresDerivedStatus } from './postgres-derived-status.ts';
import { PostgresDestination } from './postgres-destination.ts';
import { storedColumns } from './postgres-fit.ts';
import { TargetHistory, rowHash } from './postgres-history.ts';
import { PostgresLoad, type Transaction } from './postgres-load.ts';
import { TargetReaderView } from './postgres-reader-view.ts';
import { makeSchema } from './postgres-session.ts';
import type { PostgresTable } from './postgres-table.ts';
import { View, made } from './view.ts';

// The names a rule column cannot take: the dataset's own, and the history's.
const ownColumns = [
  ...Object.keys(computedColumns),
  'committed_in',
  '_elt_row_hash',
  'replaced_in',
];

// Data computed on write from what the pipeline's copies load into one
// Postgres database: a rule makes one output row for each input, such as the
// text of each stored file, as pgai's vectorizer keeps an embedding beside
// each row. The pipeline refreshes it as its copies commit; each refresh
// makes the rows whose input or rule changed and deletes the rows whose
// input is gone, and a refresh after the passes also tries failed rows
// again; the passes try each input at most once, so a failing rule is asked
// once a pass.
// A rule's failure on one input is that row's; it never fails the load.
// Readers query the view name, in the schema of into, over the table
// raw_<name>, which a refresh makes again when its declaration changes,
// since it is rebuilt from the inputs.
// A refresh is a load of the database: each of its transactions that changes
// a row is a numbered commit, each row names the commit that last wrote it,
// and the history keeps each row a commit replaced or removed, so the view
// reads as of a position as the copies' reader views do.
export class ComputedDataset<
  Input,
  Output extends string | Uint8Array,
> extends DerivedDataset<PostgresTable> {
  readonly name: string;
  // The database and schema the dataset lives in.
  readonly into: PostgresDestination;
  readonly #from: readonly (PostgresTable | View)[];
  readonly #rule: Rule<Input, Output>;
  readonly #table: string;
  readonly #history: TargetHistory;
  readonly #view: TargetReaderView;
  // Every column of an output row with its type and its constraint, in table
  // order.
  readonly #declared: readonly {
    name: string;
    type: string;
    constraint: string;
  }[];

  constructor({
    into,
    name,
    description,
    from,
    compute,
  }: {
    into: PostgresDestination;
    name: string;
    description: string;
    from: readonly (PostgresTable | View)[];
    compute: Rule<Input, Output>;
  }) {
    super();
    this.name = identifier(name, 'computed dataset name');
    this.into = into;
    this.#from = Object.freeze([...from]);
    this.#rule = compute;
    this.#table = identifier(`raw_${name}`, 'computed dataset table name');
    const taken = new Set([compute.key.name, ...ownColumns]);
    for (const column of Object.keys(compute.output)) {
      identifier(column, 'rule column name');
      if (taken.has(column))
        throw new TypeError(
          `Computed dataset ${name} cannot have the column ${column}: the dataset already has the column ${column}`,
        );
      taken.add(column);
    }
    this.#declared = Object.freeze([
      {
        name: identifier(compute.key.name, 'rule key name'),
        type: 'text',
        constraint: ' PRIMARY KEY',
      },
      ...Object.keys(computedColumns).map((column) => ({
        name: column,
        type: 'text',
        constraint: column === 'error' ? '' : ' NOT NULL',
      })),
      ...Object.entries(compute.output).map(([column, { type }]) => ({
        name: column,
        type: type === 'blob' ? 'bytea' : 'text',
        constraint: '',
      })),
      { name: 'committed_in', type: 'integer', constraint: ' NOT NULL' },
      { name: '_elt_row_hash', type: 'text', constraint: ' NOT NULL' },
    ]);
    const table = this.#qualified(this.#table);
    this.#history = new TargetHistory(
      into.schema,
      hash('sha256', JSON.stringify([into.schema, this.#table])).slice(0, 40),
    );
    this.#view = new TargetReaderView(
      { schema: into.schema, name },
      table,
      this.#history.qualifiedName,
      this.#columns,
      new TargetComments(description, {
        [compute.key.name]: compute.key.description,
        ...computedColumns,
        ...Object.fromEntries(
          Object.entries(compute.output).map(([column, { description }]) => [
            column,
            description,
          ]),
        ),
      }),
    );
    Object.freeze(this);
  }

  // The view readers query.
  get qualifiedName(): string {
    return `${this.into.schema}.${this.name}`;
  }

  // The key, the engine columns and the rule's, which readers see.
  get #columns(): string[] {
    return this.#declared
      .map(({ name }) => name)
      .filter((name) => name !== 'committed_in' && name !== '_elt_row_hash');
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
    for (const name of [this.name, this.#table])
      if (relations.has(`${this.into.schema}.${name}`))
        throw new TypeError(
          `Computed dataset ${this.name} needs ${this.into.schema}.${name}, which a copy of the pipeline makes`,
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
    await refreshComputed({
      rule: this.#rule,
      inputs: await this.#inputs(load.sql, connections),
      prepare: (keys) => this.#prepare(load, status, keys, signal),
      status,
      trigger,
      signal,
    });
  }

  // Makes the schema, brings the table to its declaration, removes the rows
  // whose key has no input, and gives the output table to write. Each
  // transaction takes the number of its commit at its first change, so one
  // that changes no row takes none. The load has one session, so the commits
  // of the calls take turns.
  async #prepare(
    load: PostgresLoad,
    status: PostgresDerivedStatus,
    keys: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PreparedOutputs<Output>> {
    const key = quote(this.#rule.key.name);
    const table = this.#qualified(this.#table);
    const commits = (sql: Transaction) => {
      let number: Promise<number> | undefined;
      return () => (number ??= load.number(sql));
    };
    await makeSchema(load.sql, this.into.schema);
    const stored = await load.transaction(async (sql) => {
      const commit = commits(sql);
      await this.#declare(sql, commit);
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
      if (gone.length > 0)
        await this.#history.remove(
          sql,
          await commit(),
          table,
          ` WHERE "_elt_old".${key} IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
          [JSON.stringify(gone)],
        );
      await this.#history.expire(sql);
      return rows;
    });
    const written = this.#declared.map(({ name }) => quote(name));
    const hashed = this.#columns.map((name) => ({ name }));
    // Writes a row in the commit that commit numbers, unless the stored row
    // has the same values: then it keeps its commit. The history keeps the
    // row it replaces.
    const store = async (
      sql: Transaction,
      commit: () => Promise<number>,
      output: OutputRow<Output>,
    ) => {
      const row = [
        output.key,
        output.inputHash,
        output.rule,
        output.status,
        output.error,
        ...Object.keys(this.#rule.output).map(
          (column) => output.values[column] ?? null,
        ),
      ];
      const version = rowHash(hashed, row);
      const [before] = await sql.unsafe<{ hash: string }[]>(
        `SELECT "_elt_row_hash" AS "hash" FROM ${table} WHERE ${key} = $1`,
        [output.key],
      );
      if (before?.hash === version) return;
      const number = await commit();
      if (before !== undefined)
        await this.#history.keep(
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
        [...row.map(parameter), number, version],
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

  // Makes the table, its history and its view, or makes the table again when
  // its declaration changed: the history keeps each row of the old table, in
  // a commit, and the views over the old table read the new one.
  async #declare(
    sql: Transaction,
    commit: () => Promise<number>,
  ): Promise<void> {
    const table = this.#qualified(this.#table);
    const stored = await storedColumns(sql, table);
    const create = `CREATE TABLE ${table} (${this.#declared
      .map(
        ({ name, type, constraint }) => `${quote(name)} ${type}${constraint}`,
      )
      .join(', ')}, CHECK ("status" IN ('computed', 'empty', 'failed')))`;
    const fits =
      stored.length === this.#declared.length &&
      stored.every(
        ({ name, type }, index) =>
          this.#declared[index]?.name === name &&
          this.#declared[index]?.type === type,
      );
    if (stored.length === 0) await sql.unsafe(create);
    else if (!fits) {
      const [kept] = await sql.unsafe(`SELECT 1 FROM ${table} LIMIT 1`);
      if (kept !== undefined) {
        await this.#history.create(sql, table, commit);
        await this.#history.keep(
          sql,
          await commit(),
          table,
          `FROM ${table} AS "_elt_old"`,
        );
      }
      await rebindDependents(
        sql,
        [table, this.#history.qualifiedName, this.#view.qualifiedName],
        async () => {
          await this.#view.drop(sql);
          await sql.unsafe(`DROP TABLE ${table}`);
          await sql.unsafe(create);
          await this.#history.create(sql, table, commit);
          await this.#view.describe(sql);
        },
      );
      return;
    }
    await this.#history.create(sql, table, commit);
    await this.#view.describe(sql);
  }

  // Each input by key, from the rows of each relation of from that exists
  // yet: what the copies loaded, through its reader view if it has one, or
  // what a view before this dataset gives. A key read twice keeps its first
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
          ? this.#qualified(target.name, target.into.schema)
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
          const read = this.#rule.read(row);
          if (read !== null && !inputs.has(read.key))
            inputs.set(read.key, read.input);
        }
    }
    return inputs;
  }

  // The relation that readers read of a target a copy of the pipeline loads:
  // its reader view, or else its table. undefined until it is first made,
  // since a table that a copy never made yet has no rows to read.
  #loaded(
    connections: readonly Connection<PostgresTable>[],
    target: PostgresTable,
  ): string | undefined {
    const destination = this.#source(connections, target);
    if (destination === undefined) return undefined;
    return target.readerView === undefined
      ? this.#qualified(target.name, destination.schema)
      : this.#qualified(target.readerView.name, target.readerView.schema);
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

  #qualified(name: string, schema = this.into.schema): string {
    return `${quote(schema)}.${quote(name)}`;
  }
}

// A value as the driver sends it: text as text, a file's bytes as bytea.
function parameter(value: string | Uint8Array | null): string | Buffer | null {
  return value instanceof Uint8Array ? Buffer.from(value) : value;
}
