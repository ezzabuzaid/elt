import { hash } from 'node:crypto';

import { Lock } from '@zukhruf/async';

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
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { makeSchema } from './sql-server-connection.ts';
import { refreshDependents } from './sql-server-dependents.ts';
import { SqlServerDerivedStatus } from './sql-server-derived-status.ts';
import { TargetDescriptions } from './sql-server-descriptions.ts';
import { SqlServerDestination, database } from './sql-server-destination.ts';
import { storedColumns } from './sql-server-fit.ts';
import { TargetHistory, rowHash } from './sql-server-history.ts';
import { identifiers, quote, rawTable } from './sql-server-identifiers.ts';
import { SqlServerLoad } from './sql-server-load.ts';
import { expireBefore } from './sql-server-numbering.ts';
import { SqlServerPartsTable } from './sql-server-parts-table.ts';
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
import {
  inMarts,
  inWarehouse,
  marts,
  warehouse,
} from './sql-server-schemas.ts';
import type { SqlServerTable } from './sql-server-table.ts';
import { View, made } from './view.ts';

// The columns of each table of the dataset that the destination writes for
// itself beside the rule's: the row number, its clustered key (ADR 0003),
// and the key hash, which is unique (ADR 0004).
const ownColumns = ['_elt_row', '_elt_key_hash'];

// A table of the dataset as its declaration makes it, with its history and
// the view readers query.
type DeclaredTable = Pick<
  SqlServerPartsTable,
  'table' | 'declared' | 'statement' | 'history' | 'view'
>;

// Data computed on write from what the pipeline's copies load into one SQL
// Server database, as in elt-postgresql: a rule makes one output row for each
// input, such as the vector of each passage. The pipeline refreshes it as its
// copies commit, through refreshComputed of elt. Readers query the view
// marts.<name>, over the table raw_<name> in _warehouse, which a refresh
// makes again when its declaration changes, since it is rebuilt from the
// inputs. Each transaction of a refresh that changes a row is a numbered
// commit, each row names the commit that last wrote it, and the history
// keeps each row that a commit replaced or removed, so the view reads as of a
// position as the copies' reader views do.
// A table rule gives many parts for one input: the dataset keeps one output
// row for each key in raw_<name>, with no rule column, and its parts in
// raw_<name>_parts, which readers query through marts.<name>_parts. The
// commit that writes an output row writes its parts, and the two tables are
// one declaration, so a change to either makes both again.
export class ComputedDataset<Input> extends DerivedDataset<SqlServerTable> {
  readonly name: string;
  // The database the dataset lives in.
  readonly into: SqlServerDestination;
  readonly #from: readonly (SqlServerTable | View)[];
  readonly #compute:
    | { readonly rule: Rule<Input, RuleColumns> }
    | {
        readonly rule: TableRule<Input, RuleColumns, RuleColumns>;
        readonly parts: SqlServerPartsTable;
      };
  // The rule columns of an output row: none for a table rule, whose columns
  // are the parts'.
  readonly #ruleColumns: RuleColumns;
  readonly #output: DeclaredTable;

  constructor({
    into,
    name,
    description,
    from,
    compute,
  }: {
    into: SqlServerDestination;
    name: string;
    description: string;
    from: readonly (SqlServerTable | View)[];
    compute:
      Rule<Input, RuleColumns> | TableRule<Input, RuleColumns, RuleColumns>;
  }) {
    super();
    this.name = name;
    this.into = into;
    this.#from = Object.freeze([...from]);
    refuseTakenColumns({
      dataset: name,
      rule: compute,
      reserved: [...reservedColumns(compute), ...ownColumns],
      key: (column) => identifiers.key(column),
    });
    this.#compute =
      compute instanceof TableRule
        ? {
            rule: compute,
            parts: new SqlServerPartsTable({
              dataset: name,
              description,
              rule: compute,
            }),
          }
        : { rule: compute };
    this.#ruleColumns = compute instanceof TableRule ? {} : compute.output;
    const table = inWarehouse(rawTable(name));
    const declared: readonly Declared[] = Object.freeze([
      { name: '_elt_row', type: 'bigint', required: true },
      { name: compute.key.name, type: 'nvarchar(max)', required: true },
      ...Object.keys(computedColumns).map((column) => ({
        name: column,
        type: 'nvarchar(max)',
        required: column !== 'error',
      })),
      ...Object.entries(this.#ruleColumns).map(([column, rule]) => ({
        name: column,
        type: ruleColumnType(column, rule),
        required: false,
      })),
      { name: 'committed_in', type: 'bigint', required: true },
      { name: '_elt_row_hash', type: 'binary(32)', required: true },
      { name: '_elt_key_hash', type: 'binary(32)', required: true },
    ]);
    const columns = declared
      .slice(1)
      .map(
        ({ name, type, required }) =>
          `${quote(name)} ${type} ${required ? 'NOT NULL' : 'NULL'}`,
      );
    const history = new TargetHistory(hash('sha256', table).slice(0, 40));
    this.#output = Object.freeze({
      table,
      declared,
      statement: `CREATE TABLE ${table} ([_elt_row] bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY CLUSTERED, ${columns.join(', ')}, CHECK ([status] IN (N'computed', N'empty', N'failed')));
      CREATE UNIQUE INDEX [key_hash] ON ${table} ([_elt_key_hash]);`,
      history,
      view: new TargetReaderView(
        name,
        table,
        history.qualifiedName,
        this.#columns,
        new TargetDescriptions(description, {
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

  // The view readers query, which a View after the dataset waits for.
  get qualifiedName(): string {
    return `${marts}.${this.name}`;
  }

  // The key, the engine columns and the rule's, which readers see and the
  // row hash counts.
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

  override validate(connections: readonly Connection<SqlServerTable>[]): void {
    for (const target of this.#from)
      if (!(target instanceof View) && !this.#loads(connections, target))
        throw new TypeError(
          `Computed dataset ${this.name} reads ${target.name}, which no copy of the pipeline loads into its database`,
        );
    const relations = made(connections, this.into);
    for (const relation of [
      this.qualifiedName,
      `${warehouse}.${rawTable(this.name)}`,
      ...('parts' in this.#compute ? this.#compute.parts.names : []),
    ])
      if (relations.has(identifiers.key(relation)))
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
    readonly connections: readonly Connection<SqlServerTable>[];
    readonly clock: PipelineClock;
    readonly signal?: AbortSignal;
    readonly trigger: RefreshTrigger;
  }): Promise<void> {
    // Open from the start, so it closes a refresh that a process ended; with
    // no commit it is no span, and leaves the positions as they are.
    await using load = await SqlServerLoad.open(
      this.into[database],
      { dataset: this.name },
      { clock, retention: this.into.retention },
    );
    const status = new SqlServerDerivedStatus(
      load.connection,
      this.qualifiedName,
      'computed',
      clock,
    );
    const refresh = {
      inputs: await this.#inputs(load.connection),
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

  // Makes marts, brings the tables to their declaration, removes the rows
  // whose key has no input, with their parts, and gives the output table to
  // write. Each transaction takes the number of its commit at its first
  // change, so one that changes no row takes none. The load has one session,
  // so the transactions of the calls take turns.
  async #prepare(
    load: SqlServerLoad,
    status: SqlServerDerivedStatus,
    keys: ReadonlySet<string>,
    signal: AbortSignal | undefined,
  ): Promise<PreparedOutputs<OutputRow | TableOutputRow>> {
    const { connection } = load;
    const { table, history } = this.#output;
    const parts = 'parts' in this.#compute ? this.#compute.parts : undefined;
    const commits = () => {
      let number: Promise<number> | undefined;
      return () => (number ??= load.number());
    };
    await makeSchema(connection, marts);
    const stored = await load.transaction(async () => {
      const commit = commits();
      await this.#declare(connection, commit);
      const rows = new Map<string, StoredOutput>();
      const gone: string[] = [];
      for (const row of await connection.query(
        `SELECT ${quote(this.#compute.rule.key.name)} AS [key], [input_hash], [rule], [status] FROM ${table}`,
      )) {
        const key = String(row.key);
        if (keys.has(key))
          rows.set(key, {
            inputHash: String(row.input_hash),
            rule: String(row.rule),
            status: String(row.status),
          });
        else gone.push(keyHash(key));
      }
      if (gone.length > 0) {
        await history.remove(
          connection,
          await commit(),
          table,
          '[_elt_key_hash] IN (SELECT CONVERT(binary(32), [value], 2) FROM OPENJSON(@gone))',
          { gone: JSON.stringify(gone) },
        );
        await parts?.remove(connection, await commit(), gone);
      }
      for (const declared of this.#tables)
        await declared.history.expire(connection);
      return rows;
    });
    const session = new Lock();
    const settle = (work: (commit: () => Promise<number>) => Promise<void>) =>
      session.run(() => load.transaction(() => work(commits())), { signal });
    return {
      stored,
      store: (output) =>
        settle((commit) => this.#write(connection, commit, [output])),
      settle: (outputs, settled) =>
        settle(async (commit) => {
          await this.#write(connection, commit, outputs);
          await status.settled(settled);
        }),
      counts: async () =>
        new Map(
          (
            await connection.query(
              `SELECT [status], COUNT(*) AS [n] FROM ${table} GROUP BY [status]`,
            )
          ).map(({ status, n }) => [String(status), Number(n)]),
        ),
    };
  }

  // Writes each output row whose values differ from its stored row in the
  // commit that commit numbers, in one MERGE whose output the history keeps
  // (ADR 0005), and the parts of each row in the same commit. A row with the
  // values of its stored row keeps its commit.
  async #write(
    connection: SqlServerConnection,
    commit: () => Promise<number>,
    outputs: readonly (OutputRow | TableOutputRow)[],
  ): Promise<void> {
    await this.#merge(connection, commit, outputs);
    if ('parts' in this.#compute)
      await this.#compute.parts.write(connection, commit, outputs);
  }

  // The MERGE of the output rows whose row hash changed.
  async #merge(
    connection: SqlServerConnection,
    commit: () => Promise<number>,
    outputs: readonly (OutputRow | TableOutputRow)[],
  ): Promise<void> {
    const { table, history } = this.#output;
    const ruleColumns = Object.entries(this.#ruleColumns);
    const rows = outputs.map((output) => {
      const values = [
        output.key,
        output.inputHash,
        output.rule,
        output.status,
        output.error,
        ...ruleColumns.map(([column]) =>
          storedValue('values' in output ? output.values[column] : undefined),
        ),
      ];
      return {
        keyHash: keyHash(output.key),
        version: rowHash(
          this.#columns.map((name) => ({ name })),
          values,
        ),
        values,
      };
    });
    const before = new Map(
      (
        await connection.query(
          `SELECT LOWER(CONVERT(char(64), [_elt_key_hash], 2)) AS [key], LOWER(CONVERT(char(64), [_elt_row_hash], 2)) AS [version]
           FROM ${table} WHERE [_elt_key_hash] IN (SELECT CONVERT(binary(32), [value], 2) FROM OPENJSON(@keys))`,
          { keys: JSON.stringify(rows.map((row) => row.keyHash)) },
        )
      ).map(({ key, version }) => [String(key), String(version)]),
    );
    const changed = rows.filter(
      (row) => before.get(row.keyHash) !== row.version,
    );
    if (changed.length === 0) return;
    // Each column as OPENJSON reads it and as the table stores it.
    const fields = [
      ...[this.#compute.rule.key.name, ...Object.keys(computedColumns)].map(
        (name) => ({
          name,
          type: 'nvarchar(max)',
          stored: (at: string) => at,
        }),
      ),
      ...ruleColumns.map(([name, column]) => ({
        name,
        type: ruleBatchType(column),
        stored: (at: string) => ruleStored(name, column, at),
      })),
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
    await history.keep(
      connection,
      committed,
      table,
      `MERGE ${table} AS t USING (${source}) AS s ON t.[_elt_key_hash] = s.[_elt_key_hash]
       WHEN MATCHED THEN UPDATE SET ${written.map((column) => `t.${column} = s.${column}`).join(', ')}
       WHEN NOT MATCHED THEN INSERT (${written.join(', ')}) VALUES (${written.map((column) => `s.${column}`).join(', ')})
       OUTPUT deleted.*`,
      {
        committed: String(committed),
        batch: JSON.stringify(
          changed.map((row) => [
            row.keyHash,
            row.version,
            ...row.values.map(batchValue),
          ]),
        ),
      },
    );
  }

  // Makes the tables, their histories and their views, or makes every table
  // again when the stored columns of one differ from its declaration, in a
  // commit: the history of each keeps each row of its old table and takes the
  // new shape, and the views over the old tables read the new ones (ADR
  // 0006). A column whose type changes in a way that a history cannot follow,
  // such as a vector of other dimensions, expires each position before the
  // commit, which only the rows of the old history read.
  async #declare(
    connection: SqlServerConnection,
    commit: () => Promise<number>,
  ): Promise<void> {
    const tables = this.#tables;
    const stored: (readonly Declared[])[] = [];
    for (const { table } of tables)
      stored.push(await storedColumns(connection, { table }));
    const missing = stored.every((columns) => columns.length === 0);
    const fits = tables.every(
      ({ declared }, index) =>
        stored[index]?.map(shape).join('\0') === declared.map(shape).join('\0'),
    );
    if (missing || fits) {
      for (const { table, statement, history, view } of tables) {
        if (missing) await connection.query(statement);
        await history.create(connection, table);
        await view.describe(connection);
      }
      return;
    }
    const committedIn = await commit();
    await refreshDependents(
      connection,
      {
        roots: tables.flatMap(({ table, history, view }) => [
          table,
          history.qualifiedName,
          view.qualifiedName,
        ]),
        views: tables.map(({ view }) => view.qualifiedName),
        changed: tables.map(({ table }) => table).join(' and '),
      },
      async () => {
        for (const [index, { table, history }] of tables.entries()) {
          if (stored[index]?.length === 0) continue;
          await history.create(connection, table);
          await history.keep(
            connection,
            committedIn,
            table,
            `SELECT * FROM ${table}`,
            {},
          );
          await connection.query(`DROP TABLE ${table}`);
        }
        for (const { table, statement, history, view } of tables) {
          await connection.query(statement);
          if ((await history.follow(connection, table)) === 'retyped')
            await expireBefore(connection, committedIn, 'type');
          await history.create(connection, table);
          await view.replace(connection);
        }
      },
    );
  }

  // Each input by key, from the rows of each relation of from that exists
  // yet: what a copy into the database loaded, which validate checked,
  // through its reader view, or what a view before this dataset gives. A key read twice keeps its first input.
  // null while the reader view of a copy is gone, such as one a person
  // dropped by hand: its copy makes it again, and the dataset waits with
  // what it made, as a view waits. Read as no rows, it would delete every
  // output, and the next refresh would pay the rule for each again.
  async #inputs(
    connection: SqlServerConnection,
  ): Promise<Map<string, Input> | null> {
    const inputs = new Map<string, Input>();
    for (const target of this.#from) {
      const relation = inMarts(target.name);
      const [exists] = await connection.query(
        'SELECT IIF(OBJECT_ID(@relation) IS NULL, 0, 1) AS [exists]',
        { relation },
      );
      if (exists?.exists !== 1) {
        if (target instanceof View) continue;
        return null;
      }
      for (const row of await connection.query(`SELECT * FROM ${relation}`)) {
        const read = this.#compute.rule.read(row);
        if (read !== null && !inputs.has(read.key))
          inputs.set(read.key, read.input);
      }
    }
    return inputs;
  }

  // Whether a copy of the pipeline loads target into the database of the
  // dataset.
  #loads(
    connections: readonly Connection<SqlServerTable>[],
    target: SqlServerTable,
  ): boolean {
    const { location } = this.into[database];
    return connections.some(
      ({ destination, steps }) =>
        destination instanceof SqlServerDestination &&
        destination[database].location === location &&
        steps.some(({ to }) => to === target),
    );
  }
}

const shape = ({ name, type, required }: Declared) =>
  `${name} ${type} ${required}`;
