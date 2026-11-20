import { hash } from 'node:crypto';

import {
  type Clearing,
  type CopyConfiguration,
  type FieldValues,
  type KeyValue,
  type Partition,
  type ReloadMode,
  type Reloads,
  SomePartitions,
  type Stage,
  TargetOwnedError,
  Writer,
  describeTarget,
  readPartitions,
  reloadMode,
  wholeStream,
} from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import type { EncodedValue, SqlServerColumn } from './sql-server-column.ts';
import {
  connect,
  lockSchema,
  makeSchema,
  transaction,
} from './sql-server-connection.ts';
import { numberOf, refreshDependents } from './sql-server-dependents.ts';
import { TargetDescriptions } from './sql-server-descriptions.ts';
import { storedColumns, storedFit } from './sql-server-fit.ts';
import { TargetHistory, rowHash } from './sql-server-history.ts';
import { quote } from './sql-server-identifiers.ts';
import type { SqlServerLoad } from './sql-server-load.ts';
import {
  commitOnce,
  databaseCopy,
  expireBefore,
  forgetCommit,
  installNumbering,
} from './sql-server-numbering.ts';
import { TargetReaderView } from './sql-server-reader-view.ts';
import { inWarehouse, marts, warehouse } from './sql-server-schemas.ts';
import type { SqlServerTable } from './sql-server-table.ts';

// A batch goes to the stage at 1,000 rows or 16 MiB of JSON, whichever comes
// first, as one parameter that OPENJSON reads (ADR 0011).
const batchSize = 1000;
const batchBytes = 16 * 2 ** 20;
export const seq = '[_elt_seq]';
// R for a record, D for a deletion of its key.
export const op = '[_elt_op]';
export const version = '[_elt_row_hash]';
export const keyHash = '[_elt_key_hash]';
const rowNumber = '[_elt_row]';

// One side of a difference: a table, what tells its rows apart, and which
// of its rows count, all of them when rows is undefined.
type Side = {
  readonly table: string;
  readonly id: string;
  readonly rows?: string;
};

// The tables in _warehouse where each writer keeps the owner of its target
// and the partitions of its open reload.
const writersTable = inWarehouse('_elt_writers');
const reloadsTable = inWarehouse('_elt_reloads');

// How long the swap of a reload waits for a reader of the target before the
// copy fails until its next run.
const swapTimeout = 3000;
// The error of a statement that waited swapTimeout for a lock.
const lockTimeout = 1222;

// The columns of a raw table that the destination writes for itself, which no
// stream declares.
const internalColumns: ReadonlySet<string> = new Set([
  '_elt_row',
  'loaded_at',
  'committed_in',
  '_elt_row_hash',
  '_elt_key_hash',
]);

// Loads a stream into its raw table: what each mode shares, the claim of the
// target, the stage of each commit, and the clear. Each mode merges the stage
// into the table in its own way. Each row is told apart by _elt_row, its
// identity number, the clustered key of the table (ADR 0003).
export abstract class SqlServerWriter extends Writer {
  readonly configuration: CopyConfiguration;
  readonly table: SqlServerTable;
  // The columns whose values the key hash of a row hashes, in this order;
  // none for a table with no key.
  abstract readonly keys: readonly SqlServerColumn[];
  protected readonly history: TargetHistory;
  readonly #database: SqlServerDatabase;
  readonly #retention: Temporal.Duration;
  readonly #descriptions: TargetDescriptions;
  readonly #view: TargetReaderView;

  constructor(
    configuration: CopyConfiguration,
    database: SqlServerDatabase,
    table: SqlServerTable,
    retention: Temporal.Duration,
  ) {
    super(configuration.stream);
    if (table.columns.some(({ fileRead }) => fileRead !== undefined))
      throw new TypeError(
        `Reader view ${marts}.${table.name} reads files, which the SQL Server destination does not load yet`,
      );
    this.configuration = configuration;
    this.table = table;
    this.#database = database;
    this.#retention = retention;
    this.history = new TargetHistory(this.#hash);
    // No column reads a file, so none stores one.
    const description = describeTarget(configuration, table.columns, () => '');
    const { missing } = description;
    if (missing.length > 0)
      throw new TypeError(
        `Reader view ${marts}.${table.name} needs JSON Schema descriptions for ${missing.join(', ')} of stream ${this.stream.name}`,
      );
    this.#descriptions = new TargetDescriptions(description.table, {
      ...description.columns,
      committed_in: `Number of the commit that last wrote this row: the row of ${warehouse}._elt_commits with this number tells when, and in which load.`,
    });
    this.#view = new TargetReaderView(
      table.name,
      this.qualifiedName,
      this.history.qualifiedName,
      [...table.columns.map(({ name }) => name), 'loaded_at'],
      new TargetDescriptions(description.table, description.columns),
    );
  }

  get qualifiedName(): string {
    return inWarehouse(this.table.raw);
  }

  get #hash(): string {
    return hash('sha256', this.qualifiedName).slice(0, 40);
  }

  // A reload's hidden target, beside the target and invisible to readers.
  get #hidden(): string {
    return inWarehouse(`_elt_next_${this.#hash}`);
  }

  // The name that the target takes in the swap of a reload, before it goes.
  get #replacedName(): string {
    return `_elt_replaced_${this.#hash}`;
  }

  // The key hash of a table with a key, as its only element: a key column of
  // nvarchar(max) cannot be an index key, and its collation would take two
  // keys that differ in case for one (ADR 0004).
  get #keyHashes(): readonly string[] {
    return this.keys.length > 0 ? [keyHash] : [];
  }

  // The unique index on the key hash, named after the table, its key and the
  // types of the key, so a table whose stored hashes are of another key, or
  // of key values of another type, no longer fits, and no evolve takes it.
  get #keyIndex(): string | null {
    return this.keys.length > 0
      ? `_elt_key_${hash('sha256', JSON.stringify([this.table.raw, this.keys.map(({ name, storageType }) => [name, storageType])])).slice(0, 40)}`
      : null;
  }

  // Refuses, before anything is read, stored rows the load cannot keep.
  protected async inspect(_connection: SqlServerConnection): Promise<void> {}

  // Moves the stage into into, the table or the hidden target of a reload, as
  // one commit, numbered in written, and gives whether it changed a row.
  // history keeps the rows of the table that the merge replaces or removes;
  // it is null for a hidden target, whose rows no reader saw.
  protected abstract merge(
    connection: SqlServerConnection,
    stage: string,
    written: Written,
    into: string,
    history: TargetHistory | null,
  ): Promise<boolean>;

  // An overwrite replaces the rows of the target at the first commit of its
  // run.
  protected get replaces(): boolean {
    return false;
  }

  // Which rows of the stage a commit that replaces the target keeps, as a
  // condition on them.
  protected kept(_stage: string): string {
    return `${op} = 'R'`;
  }

  // The ids of the rows of left that no row of right matches, as multisets:
  // the k-th copy of some values on one side matches the k-th copy of the
  // same values on the other, so no key is needed.
  #unmatched(left: Side, right: Side): string {
    const numbered = ({ table, id, rows }: Side) =>
      `SELECT ${id} AS [_elt_id], ${version} AS [_elt_hash], ROW_NUMBER() OVER (PARTITION BY ${version} ORDER BY ${id}) AS [_elt_copy] FROM ${table}${rows === undefined ? '' : ` WHERE ${rows}`}`;
    return `SELECT [_elt_mine].[_elt_id] FROM (${numbered(left)}) AS [_elt_mine] LEFT JOIN (${numbered(right)}) AS [_elt_theirs] ON [_elt_theirs].[_elt_hash] = [_elt_mine].[_elt_hash] AND [_elt_theirs].[_elt_copy] = [_elt_mine].[_elt_copy] WHERE [_elt_theirs].[_elt_id] IS NULL`;
  }

  // Replaces the rows of the target with the records that the stage keeps,
  // by difference: the history keeps each row of the target that no record
  // matches, and the row goes; a row with a match stays as it is, with its
  // commit and its loaded_at; and each record that no row matches enters
  // with this commit. What stays matches records, so it fits the index of
  // the key hash, which the records that enter then fit too. Gives whether it
  // changed a row.
  async #replace(
    connection: SqlServerConnection,
    stage: string,
    written: Written,
  ): Promise<boolean> {
    const target = { table: this.qualifiedName, id: rowNumber };
    const staged = { table: stage, id: seq, rows: this.kept(stage) };
    const removed = await this.history.remove(
      connection,
      written.committedIn,
      this.qualifiedName,
      `${rowNumber} IN (${this.#unmatched(target, staged)})`,
      {},
    );
    const [entered] = await connection.query(
      `INSERT INTO ${this.qualifiedName} (${this.written.join(', ')})
       SELECT ${this.staged('[_elt_new]').join(', ')} FROM ${stage} AS [_elt_new] WHERE [_elt_new].${seq} IN (${this.#unmatched(staged, target)}) ORDER BY [_elt_new].${seq};
       SELECT @@ROWCOUNT AS [rows];`,
      writtenParameters(written),
    );
    return removed > 0 || entered?.rows !== 0;
  }

  protected encode(record: unknown): EncodedValue[] {
    return this.table.columns.map((column) => column.encode(record));
  }

  // Only a load that identifies rows by key can remove one: the key's values,
  // at their columns, and null elsewhere.
  protected deletionRow(
    _key: Readonly<Record<string, KeyValue>>,
  ): EncodedValue[] {
    throw new TypeError('Only deduplicating loads can apply deletions');
  }

  // What a commit writes into each row: its values, when its load began, its
  // number, and its hashes.
  protected get written(): string[] {
    return [
      ...this.table.columns.map((column) => column.quotedName),
      '[loaded_at]',
      '[committed_in]',
      version,
      ...this.#keyHashes,
    ];
  }

  // The value of each column of written, from the row of the stage that alias
  // names.
  protected staged(alias: string): string[] {
    return [
      ...this.table.columns.map((column) => `${alias}.${column.quotedName}`),
      'CAST(@loaded AS datetimeoffset(3))',
      'CAST(@committed AS bigint)',
      `${alias}.${version}`,
      ...this.#keyHashes.map((column) => `${alias}.${column}`),
    ];
  }

  // A table named name with the target's columns, clustered on its row
  // number.
  #tableSQL(name: string): string {
    if (this.table.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `${name} (${rowNumber} bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY CLUSTERED, ${[
      ...this.table.columns.map((column) => column.definition),
      '[loaded_at] datetimeoffset(3) NOT NULL',
      '[committed_in] bigint NOT NULL',
      `${version} binary(32) NULL`,
      ...this.#keyHashes.map((column) => `${column} binary(32) NOT NULL`),
    ].join(', ')})`;
  }

  // The owner lives beside the table it guards. A dropped table releases it,
  // since nothing it held remains.
  async #refuse(
    connection: SqlServerConnection,
    writer: string,
  ): Promise<void> {
    const [row] = await connection.query(
      `SELECT [writer] FROM ${writersTable} WHERE [target] = @target AND OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME([target]), N'U') IS NOT NULL`,
      { target: this.table.raw, schema: warehouse },
    );
    if (row !== undefined && row.writer !== writer)
      throw new TargetOwnedError(this.table.name, String(row.writer), writer);
  }

  // Records the owner with the target's first commit; prepare refused any
  // other.
  async #own(connection: SqlServerConnection, writer: string): Promise<void> {
    await connection.query(
      `DELETE FROM ${writersTable} WHERE OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME([target]), N'U') IS NULL;
       IF NOT EXISTS (SELECT 1 FROM ${writersTable} WHERE [target] = @target)
         INSERT INTO ${writersTable} ([target], [writer]) VALUES (@target, @writer);`,
      { target: this.table.raw, writer, schema: warehouse },
    );
  }

  // The target as its first commit makes it: its owner, the table, its
  // history and its descriptions, and the reader view.
  async #create(
    connection: SqlServerConnection,
    writer: string,
  ): Promise<void> {
    await this.#own(connection, writer);
    await connection.query(
      `IF OBJECT_ID(@table, N'U') IS NULL
       BEGIN
         CREATE TABLE ${this.#tableSQL(this.qualifiedName)};
         ${this.#keyIndex === null ? '' : `CREATE UNIQUE INDEX ${quote(this.#keyIndex)} ON ${this.qualifiedName} (${keyHash});`}
       END`,
      { table: this.qualifiedName },
    );
    await this.history.create(connection, this.qualifiedName);
    await this.#descriptions.write(
      connection,
      'TABLE',
      warehouse,
      this.table.raw,
    );
    await this.#view.describe(connection);
  }

  // The rows of any of the partitions, as a condition over the columns of a
  // table of the target's shape, with one JSON parameter for each partition.
  // Text compares by its code points, as the source tells its partitions
  // apart, not in the collation of the database, which takes two values that
  // differ only in case for one. unnamed selects the rows that leave out a
  // column of a partition, such as a staged deletion whose key does not name
  // it.
  #within(partitions: readonly Partition[]): Within {
    const parameters: Record<string, string> = {};
    const named = new Set<SqlServerColumn>();
    const each = partitions.map((partition, index) => {
      const columns = Object.keys(partition).map((field) => {
        const column = this.table.columns.find(
          (column) => column.field === field,
        );
        if (column === undefined)
          throw new TypeError(
            `Resetting a partition requires destination column ${field}`,
          );
        named.add(column);
        return column;
      });
      const parameter = `partition${index}`;
      // One row, as OPENJSON reads the rows of a batch.
      parameters[parameter] = JSON.stringify([
        columns.map((column) => column.encode(partition)),
      ]);
      return columns
        .map((column, at) => {
          const binary = column.storageType.startsWith('nvarchar')
            ? ' COLLATE Latin1_General_100_BIN2'
            : '';
          return `${column.quotedName}${binary} = (SELECT ${column.stored('j.[v]')} FROM OPENJSON(@${parameter}) WITH ([v] ${column.batchType} '$[${at}]') AS j)${binary}`;
        })
        .join(' AND ');
    });
    return {
      rows:
        each.length === 0
          ? '1 = 0'
          : each.map((condition) => `(${condition})`).join(' OR '),
      unnamed: [...named]
        .map((column) => `${column.quotedName} IS NULL`)
        .join(' OR '),
      parameters,
    };
  }

  // The partitions that an open reload of the target reloads, in the
  // writer's own table beside it, written in the commit that opens or
  // continues the reload, so a run that resumes the reload continues it. A
  // reload of the whole stream has no row.
  async #reloading(connection: SqlServerConnection): Promise<Reloads> {
    const [row] = await connection.query(
      `SELECT [partitions] FROM ${reloadsTable} WHERE [target] = @target`,
      { target: this.table.raw },
    );
    return row === undefined
      ? wholeStream
      : new SomePartitions(
          readPartitions(this.stream, JSON.parse(String(row.partitions))),
        );
  }

  async #reload(
    connection: SqlServerConnection,
    reloads: Reloads,
  ): Promise<void> {
    if (!(reloads instanceof SomePartitions)) {
      await this.#reloaded(connection);
      return;
    }
    await connection.query(
      `UPDATE ${reloadsTable} SET [partitions] = @partitions WHERE [target] = @target;
       IF @@ROWCOUNT = 0 INSERT INTO ${reloadsTable} ([target], [partitions]) VALUES (@target, @partitions);`,
      {
        target: this.table.raw,
        partitions: JSON.stringify(reloads.partitions),
      },
    );
  }

  async #reloaded(connection: SqlServerConnection): Promise<void> {
    await connection.query(
      `DELETE FROM ${reloadsTable} WHERE [target] = @target`,
      { target: this.table.raw },
    );
  }

  // The hidden target of a new reload, with the target's columns and the
  // index of its key hash, which a deduplicating merge fills it by.
  async #createHidden(connection: SqlServerConnection): Promise<void> {
    await connection.query(
      `DROP TABLE IF EXISTS ${this.#hidden};
       CREATE TABLE ${this.#tableSQL(this.#hidden)};
       ${this.#keyIndex === null ? '' : `CREATE UNIQUE INDEX ${quote(this.#keyIndex)} ON ${this.#hidden} (${keyHash});`}`,
    );
  }

  // Gives a completed reload's rows to a target that still has the stream's
  // shape, in place and by difference: the history keeps each row of the
  // target, or of the rows of it that scope selects, that no row of the
  // hidden target matches, and the row goes; a row with a match stays, with
  // its commit and its loaded_at, and the target keeps its grants and the
  // views over it. Each row of the hidden target that no row matches enters
  // with this commit, and the loaded_at of the load that wrote it. Gives
  // whether it changed a row.
  async #reloadInPlace(
    connection: SqlServerConnection,
    committedIn: number,
    scope: Within | null,
  ): Promise<boolean> {
    const parameters = scope?.parameters ?? {};
    const target: Side = {
      table: this.qualifiedName,
      id: rowNumber,
      ...(scope === null ? {} : { rows: scope.rows }),
    };
    const reloaded: Side = { table: this.#hidden, id: rowNumber };
    const removed = await this.history.remove(
      connection,
      committedIn,
      this.qualifiedName,
      `${rowNumber} IN (${this.#unmatched(target, reloaded)})`,
      parameters,
    );
    const [entered] = await connection.query(
      `INSERT INTO ${this.qualifiedName} (${this.written.join(', ')})
       SELECT ${[...this.table.columns.map((column) => column.quotedName), '[loaded_at]', 'CAST(@committed AS bigint)', version, ...this.#keyHashes].join(', ')}
       FROM ${this.#hidden} WHERE ${rowNumber} IN (${this.#unmatched(reloaded, target)}) ORDER BY ${rowNumber};
       SELECT @@ROWCOUNT AS [rows];`,
      { ...parameters, committed: String(committedIn) },
    );
    await connection.query(`DROP TABLE ${this.#hidden}`);
    return removed > 0 || entered?.rows !== 0;
  }

  // The permissions of the target, and of each of its columns that the
  // stream still has, as the statements that give them to the table that
  // takes its place.
  async #grants(connection: SqlServerConnection): Promise<string[]> {
    const names = new Set(this.table.columns.map(({ name }) => name));
    const rows = await connection.query(
      `SELECT p.[state_desc], p.[permission_name], USER_NAME(p.[grantee_principal_id]) AS [grantee], COL_NAME(p.[major_id], p.[minor_id]) AS [column]
       FROM sys.database_permissions AS p WHERE p.[class] = 1 AND p.[major_id] = OBJECT_ID(@table)`,
      { table: this.qualifiedName },
    );
    return rows.flatMap(({ state_desc, permission_name, grantee, column }) => {
      if (column !== null && !names.has(String(column))) return [];
      const state = String(state_desc);
      const on = `${this.qualifiedName}${column === null ? '' : ` (${quote(String(column))})`}`;
      return [
        state === 'GRANT_WITH_GRANT_OPTION'
          ? `GRANT ${String(permission_name)} ON ${on} TO ${quote(String(grantee))} WITH GRANT OPTION`
          : `${state} ${String(permission_name)} ON ${on} TO ${quote(String(grantee))}`,
      ];
    });
  }

  // Swaps a completed reload's hidden target in, when the target no longer
  // has the stream's shape, so readers of the stored table wait only for the
  // swap, not the reload. A reader that holds it past the timeout fails the
  // copy until the next run. Its rows are new to readers at this commit, and
  // the history keeps every row of the target it replaces, unless the change
  // retypes a column that the history keeps: each position before it then
  // expires. The table takes the target's permissions, the reader view is
  // defined again over the new columns, and the
  // views over the table, its history or its reader view refresh (ADR 0006).
  // SET LOCK_TIMEOUT lasts to the end of a batch with parameters, so it is a
  // batch with none.
  async #swap(
    connection: SqlServerConnection,
    committedIn: number,
  ): Promise<void> {
    await connection.query(`SET LOCK_TIMEOUT ${swapTimeout}`);
    try {
      await connection.query(
        `UPDATE ${this.#hidden} SET [committed_in] = CAST(@committed AS bigint)`,
        { committed: String(committedIn) },
      );
      const relations = [
        this.qualifiedName,
        this.history.qualifiedName,
        this.#view.qualifiedName,
      ];
      await refreshDependents(
        connection,
        {
          roots: relations,
          views: [this.#view.qualifiedName],
          changed: this.qualifiedName,
        },
        async () => {
          const [target] = await connection.query(
            `SELECT IIF(OBJECT_ID(@table, N'U') IS NULL, 0, 1) AS [made]`,
            { table: this.qualifiedName },
          );
          const replacing = target?.made === 1;
          const grants = replacing ? await this.#grants(connection) : [];
          if (replacing) {
            if (
              (await this.history.follow(connection, this.#hidden)) ===
              'retyped'
            )
              await expireBefore(connection, committedIn, 'type');
            else
              await this.history.keep(
                connection,
                committedIn,
                this.qualifiedName,
                `SELECT * FROM ${this.qualifiedName}`,
                {},
              );
            await connection.query('EXEC sp_rename @table, @replaced', {
              table: this.qualifiedName,
              replaced: this.#replacedName,
            });
          }
          await connection.query('EXEC sp_rename @hidden, @raw', {
            hidden: this.#hidden,
            raw: this.table.raw,
          });
          if (replacing)
            await connection.query(
              `DROP TABLE ${inWarehouse(this.#replacedName)}`,
            );
          for (const grant of grants) await connection.query(grant);
          await this.history.create(connection, this.qualifiedName);
          await this.#descriptions.write(
            connection,
            'TABLE',
            warehouse,
            this.table.raw,
          );
          await this.#view.replace(connection);
        },
      );
    } finally {
      await connection.query('SET LOCK_TIMEOUT -1');
    }
  }

  // Refuses a conversion of a stored column from its type from to the type
  // of column that would change a stored value, such as 1.5 in a float to
  // the bigint 2, before the ALTER: each value that is not null must convert
  // back to itself, as elt-postgresql checks. A conversion from text is the
  // parse that the load applies to each value of the new type, so it is
  // trusted, and a value that it cannot parse fails the ALTER. JSON has no
  // comparison, so it compares as its text.
  async #refuseInexactCast(
    connection: SqlServerConnection,
    column: SqlServerColumn,
    from: string,
  ): Promise<void> {
    if (from === 'nvarchar(max)') return;
    const { quotedName: name, storageType: to } = column;
    const back = `TRY_CAST(TRY_CAST(${name} AS ${to}) AS ${from})`;
    const differs =
      from === 'json'
        ? `CAST(${back} AS nvarchar(max)) COLLATE Latin1_General_100_BIN2 <> CAST(${name} AS nvarchar(max)) COLLATE Latin1_General_100_BIN2`
        : `${back} <> ${name}`;
    let changes: readonly unknown[];
    try {
      changes = await connection.query(
        `SELECT TOP (1) 1 AS [changed] FROM ${this.qualifiedName} WHERE ${name} IS NOT NULL AND (${back} IS NULL OR ${differs})`,
      );
    } catch (cause) {
      throw new TypeError(
        `column ${name} does not convert to ${to}: ${Error.isError(cause) ? cause.message : String(cause)}`,
        { cause },
      );
    }
    if (changes.length > 0)
      throw new TypeError(
        `column ${name} holds a value that a conversion to ${to} would change`,
      );
  }

  // Drops the CHECK constraints on a column of the target, such as the one of
  // an array column, which stop an ALTER or a DROP of the column.
  async #dropChecks(
    connection: SqlServerConnection,
    column: string,
  ): Promise<void> {
    const checks = await connection.query(
      `SELECT k.[name] FROM sys.check_constraints AS k JOIN sys.columns AS c ON c.[object_id] = k.[parent_object_id] AND c.[column_id] = k.[parent_column_id]
       WHERE k.[parent_object_id] = OBJECT_ID(@table) AND c.[name] = @column`,
      { table: this.qualifiedName, column },
    );
    for (const { name } of checks)
      await connection.query(
        `ALTER TABLE ${this.qualifiedName} DROP CONSTRAINT ${quote(String(name))}`,
      );
  }

  // Brings a stored table that the stream no longer fits to its shape in
  // place, keeping every row, as elt-postgresql does: a column that the
  // stream adds enters nullable, one that it drops goes, and a changed type
  // converts with ALTER COLUMN, after the check that the conversion keeps
  // each value. The change is one commit of its own, which waits for readers
  // at most swapTimeout, as a swap does: a reader that holds the table fails
  // the copy until the next run, and the transaction leaves the table as it
  // was. A row with a value in a column that the change drops or converts
  // loses or changes the value, so it is a new version: the history keeps
  // the row as it was, and its row hash becomes NULL, which matches no
  // record until a commit writes the row again. A column that the change
  // adds is NULL in each row, which a row hash does not count. The history
  // follows the new shape; a change of type that is not a widening expires
  // each position before the commit. A commit that kept no row and expired
  // no position takes back its commit row. The key hashes cannot be made
  // again from the stored rows, so a table whose key index is of another key
  // fails the copy.
  async #evolve(load: SqlServerLoad, stage: string): Promise<void> {
    const { connection } = load;
    const keyIndex = this.#keyIndex;
    const table = this.qualifiedName;
    const [hashes] =
      keyIndex === null
        ? await connection.query(
            `SELECT IIF(COL_LENGTH(@table, N'_elt_key_hash') IS NULL, 1, 0) AS [fit]`,
            { table },
          )
        : await connection.query(
            'SELECT IIF(EXISTS (SELECT 1 FROM sys.indexes WHERE [object_id] = OBJECT_ID(@table) AND [name] = @index), 1, 0) AS [fit]',
            { table, index: keyIndex },
          );
    if (hashes?.fit !== 1)
      throw new TypeError(
        `${table} no longer has the shape of stream ${this.stream.name}, and its stored key hashes are of another key or of key values of another type; clear the copy to load it again`,
      );
    await connection.query(`SET LOCK_TIMEOUT ${swapTimeout}`);
    try {
      await load.commit(async (committedIn) => {
        const stored = new Map(
          (await storedColumns(connection, { table: this.qualifiedName })).map(
            (column) => [column.name, column],
          ),
        );
        const types = new Map(
          (await storedColumns(connection, { stage })).map(({ name, type }) => [
            name,
            type,
          ]),
        );
        const changed = [...stored.values()]
          .filter(
            ({ name, type }) =>
              !internalColumns.has(name) && types.get(name) !== type,
          )
          .map(({ name }) => `${quote(name)} IS NOT NULL`)
          .join(' OR ');
        const kept =
          changed === ''
            ? 0
            : await this.history.keep(
                connection,
                committedIn,
                this.qualifiedName,
                `UPDATE ${this.qualifiedName} SET [committed_in] = CAST(@committed AS bigint), [loaded_at] = CAST(@loaded AS datetimeoffset(3)), ${version} = NULL OUTPUT deleted.* WHERE ${changed}`,
                writtenParameters({ loadedAt: load.loadedAt, committedIn }),
              );
        let retyped = false;
        // refreshDependents names the schema-bound views that stop the
        // change; any other error that is not the wait for a reader is a
        // stored value that the new shape refuses.
        try {
          await refreshDependents(
            connection,
            {
              roots: [
                this.qualifiedName,
                this.history.qualifiedName,
                this.#view.qualifiedName,
              ],
              views: [this.#view.qualifiedName],
              changed: this.qualifiedName,
            },
            async () => {
              await this.#alter(connection, stored, types);
              retyped =
                (await this.history.follow(connection, this.qualifiedName)) ===
                'retyped';
              if (retyped) await expireBefore(connection, committedIn, 'type');
              await this.history.create(connection, this.qualifiedName);
              await this.#descriptions.write(
                connection,
                'TABLE',
                warehouse,
                this.table.raw,
              );
              await this.#view.replace(connection);
            },
          );
        } catch (cause) {
          if (cause instanceof TypeError || numberOf(cause) === lockTimeout)
            throw cause;
          throw new TypeError(
            `The rows stored in ${table} do not fit the new shape of stream ${this.stream.name}: ${Error.isError(cause) ? cause.message : String(cause)}. Clear the copy to load it again, or change the stream so they fit.`,
            { cause },
          );
        }
        if (kept === 0 && !retyped) await forgetCommit(connection, committedIn);
      });
    } finally {
      await connection.query('SET LOCK_TIMEOUT -1');
    }
  }

  // The ALTER statements of #evolve, from the stored columns and the types
  // that the stage spells for the stream's columns.
  async #alter(
    connection: SqlServerConnection,
    stored: ReadonlyMap<
      string,
      { readonly type: string; readonly required: boolean }
    >,
    types: ReadonlyMap<string, string>,
  ): Promise<void> {
    const alter = (statement: string) =>
      connection.query(`ALTER TABLE ${this.qualifiedName} ${statement}`);
    for (const column of this.table.columns) {
      const existing = stored.get(column.name);
      if (existing === undefined) {
        await alter(`ADD ${column.definition}`);
        continue;
      }
      const retyped = existing.type !== types.get(column.name);
      if (!retyped && existing.required === column.isPrimaryKey) continue;
      if (retyped)
        await this.#refuseInexactCast(connection, column, existing.type);
      await this.#dropChecks(connection, column.name);
      await alter(
        `ALTER COLUMN ${column.quotedName} ${column.storageType} ${column.isPrimaryKey ? 'NOT NULL' : 'NULL'}`,
      );
      if (column.array)
        await alter(`ADD CHECK (ISJSON(${column.quotedName}, ARRAY) = 1)`);
    }
    const declared = new Set(this.table.columns.map(({ name }) => name));
    for (const name of stored.keys())
      if (!declared.has(name) && !internalColumns.has(name)) {
        await this.#dropChecks(connection, name);
        await alter(`DROP COLUMN ${quote(name)}`);
      }
  }

  // A clear of a stored table is a load of one commit of its connection. It
  // empties the table, not drops it, so the views built on it keep working,
  // and it forgets the rows it removes: each position before it expires.
  override async clear(
    { writer, clock, connection: connector }: Clearing,
    committed?: (values: FieldValues) => Promise<void>,
  ): Promise<void> {
    await using connection = await connect(this.#database);
    await installNumbering(connection, await databaseCopy(connection));
    await makeWriterTables(connection);
    await transaction(connection, async () => {
      const [row] = await connection.query(
        `SELECT [writer] FROM ${writersTable} WHERE [target] = @target`,
        { target: this.table.raw },
      );
      if (row !== undefined && row.writer !== writer)
        throw new TargetOwnedError(this.table.name, String(row.writer), writer);
      const [table] = await connection.query(
        `SELECT IIF(OBJECT_ID(@table, N'U') IS NULL, 0, 1) AS [made]`,
        { table: this.qualifiedName },
      );
      if (table?.made === 1) {
        const committedIn = await commitOnce(
          connection,
          connector,
          new Date(clock.Date.now()),
          this.#retention,
        );
        await connection.query(`DELETE FROM ${this.qualifiedName}`);
        await expireBefore(connection, committedIn, 'clear');
        await this.history.expire(connection);
      }
      await connection.query(
        `DELETE FROM ${writersTable} WHERE [target] = @target`,
        { target: this.table.raw },
      );
      // Clearing a copy also abandons the reload it left open.
      await connection.query(`DROP TABLE IF EXISTS ${this.#hidden}`);
      await this.#reloaded(connection);
    });
    await committed?.(noFiles);
  }

  // One stream's load. Operations wait in a #temp table of the load's
  // connection, so no other session sees them and a crash leaves nothing
  // behind. prepare only refuses and stages, so a run that fails before a
  // commit leaves no rows behind. Each commit is one transaction that merges
  // the stage into the table, or into a reload's hidden target until
  // complete() gives its rows to the table. The first commit also makes the
  // table, or the hidden target of a new reload.
  async prepare(
    load: SqlServerLoad,
    { writer, reloading }: { writer: string; reloading: boolean },
  ): Promise<Stage> {
    const { connection } = load;
    const stage = `#elt_stage_${this.#hash}`;
    // The rows of a commit that belong to the partitions a reload reloads.
    const reloadStage = `#elt_reload_stage_${this.#hash}`;
    const { columns } = this.table;
    const staging = (table: string) =>
      `DROP TABLE IF EXISTS ${table}; CREATE TABLE ${table} (${[
        `${seq} bigint NOT NULL PRIMARY KEY`,
        `${op} char(1) NOT NULL`,
        ...columns.map(
          (column) => `${column.quotedName} ${column.storageType} NULL`,
        ),
        ...[version, ...this.#keyHashes].map(
          (column) => `${column} binary(32) NULL`,
        ),
      ].join(', ')});`;
    await makeWriterTables(connection);
    // A #temp table that a batch with parameters makes is dropped at the end
    // of that batch, so the stages are made by a batch with none.
    await connection.query(`${staging(stage)} ${staging(reloadStage)}`);
    // What an open reload reloads; the whole stream until a RESET of a
    // partition opens one.
    let reloads: Reloads = wholeStream;
    const fit = (table: string) =>
      storedFit(connection, this.table, {
        table,
        stage,
        keyIndex: this.#keyIndex,
      });
    let mode: ReloadMode = await load.transaction(async () => {
      await this.#refuse(connection, writer);
      const target = await fit(this.qualifiedName);
      const decided = reloadMode({
        reloading,
        destinationSyncMode: this.configuration.destinationSyncMode,
        target,
        hidden: await fit(this.#hidden),
      });
      // A hidden target no reload continues is a leftover readers never saw.
      if (decided === 'continue') reloads = await this.#reloading(connection);
      else {
        await connection.query(`DROP TABLE IF EXISTS ${this.#hidden}`);
        await this.#reloaded(connection);
      }
      await this.#view.refuse(connection, target === 'stale');
      if (decided === 'load' && !this.replaces) await this.inspect(connection);
      return decided;
    });
    if (mode === 'evolve') {
      await this.#evolve(load, stage);
      await load.transaction(() => this.inspect(connection));
      mode = 'load';
    }
    const fresh = mode === 'create' || mode === 'reload';
    // The reload as the last commit left it, which a discard goes back to.
    let committed: { readonly mode: ReloadMode; readonly reloads: Reloads } = {
      mode,
      reloads,
    };
    const open = () => mode === 'reload' || mode === 'continue';
    const into = () => (open() ? this.#hidden : this.qualifiedName);
    // Each staged row as JSON: its place in the stream, its operation, its
    // values, and the hashes, as hex, which the stage keeps as binary(32).
    const hashes = [version, ...this.#keyHashes];
    const insert = `INSERT INTO ${stage} (${[seq, op, ...columns.map((column) => column.quotedName), ...hashes].join(', ')})
      SELECT ${['j.[s]', 'j.[o]', ...columns.map((column, index) => column.stored(`j.[v${index}]`)), ...hashes.map((_, index) => `CONVERT(binary(32), j.[h${index}], 2)`)].join(', ')}
      FROM OPENJSON(@batch) WITH (${[
        `[s] bigint '$[0]'`,
        `[o] char(1) '$[1]'`,
        ...columns.map(
          (column, index) =>
            `[v${index}] ${column.batchType} '$[${index + 2}]'${column.array ? ' AS JSON' : ''}`,
        ),
        ...hashes.map(
          (_, index) =>
            `[h${index}] char(64) '$[${columns.length + 2 + index}]'`,
        ),
      ].join(', ')}) AS j`;
    const keyed = this.keys.map((key) => columns.indexOf(key));
    let pending: string[] = [];
    let pendingBytes = 0;
    let next = 0;
    const flush = async () => {
      if (pending.length === 0) return;
      const rows = pending;
      pending = [];
      pendingBytes = 0;
      await connection.query(insert, { batch: `[${rows.join(',')}]` });
    };
    // Partitions the stage dropped, which the next commit empties in the
    // table it merges into.
    let resets: Partition[] = [];
    const drop = async () => {
      pending = [];
      pendingBytes = 0;
      resets = [];
      await connection.query(`TRUNCATE TABLE ${stage}`);
    };
    // Moves the stage into the target, or the hidden target of an open
    // reload, and gives whether a reader sees a row change. The first commit
    // of an overwrite that loads into its target replaces the rows of the
    // target. The rows of the partitions that a reload reloads go to the
    // hidden target, the others to the target; a deletion whose key does not
    // name its partition goes to both, so the reload cannot bring back a row
    // that the source deleted.
    const merge = async (written: Written, replacing: boolean) => {
      if (replacing) return this.#replace(connection, stage, written);
      if (!open())
        return this.merge(
          connection,
          stage,
          written,
          this.qualifiedName,
          this.history,
        );
      if (!(reloads instanceof SomePartitions)) {
        await this.merge(connection, stage, written, this.#hidden, null);
        return false;
      }
      const { rows, unnamed, parameters } = this.#within(reloads.partitions);
      await connection.query(
        `INSERT INTO ${reloadStage} SELECT * FROM ${stage} WHERE (${rows}) OR (${op} = 'D' AND (${unnamed}));
         DELETE FROM ${stage} WHERE ${rows};`,
        parameters,
      );
      const changed = await this.merge(
        connection,
        stage,
        written,
        this.qualifiedName,
        this.history,
      );
      await this.merge(connection, reloadStage, written, this.#hidden, null);
      await connection.query(`TRUNCATE TABLE ${reloadStage}`);
      return changed;
    };
    // The first commit claims the target: it owns the hidden target of a
    // reload, or makes the table, before its transaction making marts for
    // the reader view, and the made table is a change even with no row; or it
    // finds the table made. A commit of a made target that no reader sees
    // change takes back its commit row.
    const unclaimed = (): Claim => {
      if (open())
        return {
          before: async () => {},
          claim: () => this.#own(connection, writer),
          changedNone: (committedIn) => forgetCommit(connection, committedIn),
          replaces: false,
        };
      if (mode === 'create')
        return {
          before: () => makeSchema(connection, marts),
          claim: () => this.#create(connection, writer),
          changedNone: async () => {},
          replaces: this.replaces,
        };
      return { ...claimed, replaces: this.replaces };
    };
    const claimed: Claim = {
      before: async () => {},
      claim: async () => {},
      changedNone: (committedIn) => forgetCommit(connection, committedIn),
      replaces: false,
    };
    let claiming = unclaimed;
    return {
      fresh,
      get reloading() {
        return open();
      },
      values: noFiles,
      apply: async (operation) => {
        if (operation.type === 'RESET') {
          await flush();
          const { partition } = operation;
          if (partition === null) {
            // The whole stream starts over in a new hidden target.
            await drop();
            mode = 'reload';
            reloads = wholeStream;
            return;
          }
          const { rows, parameters } = this.#within([partition]);
          await connection.query(
            `DELETE FROM ${stage} WHERE ${rows}`,
            parameters,
          );
          resets.push(partition);
          // The partition starts over in a hidden target, and readers see its
          // rows as they were until the stream ends. An overwrite replaces
          // the whole target anyway.
          if (this.replaces) return;
          if (mode === 'load') {
            mode = 'reload';
            reloads = new SomePartitions([partition]);
          } else if (open() && reloads instanceof SomePartitions)
            reloads = reloads.with(partition);
          return;
        }
        const row =
          operation.type === 'RECORD'
            ? this.encode(operation.data)
            : this.deletionRow(operation.key);
        const text = JSON.stringify([
          next++,
          operation.type === 'RECORD' ? 'R' : 'D',
          ...row,
          operation.type === 'RECORD' ? rowHash(columns, row) : null,
          ...this.#keyHashes.map(() =>
            hash('sha256', JSON.stringify(keyed.map((index) => row[index]))),
          ),
        ]);
        const bytes = Buffer.byteLength(text);
        if (pendingBytes + bytes > batchBytes) await flush();
        pending.push(text);
        pendingBytes += bytes;
        if (pending.length >= batchSize || pendingBytes >= batchBytes)
          await flush();
      },
      commit: async () => {
        await flush();
        const claim = claiming();
        await claim.before();
        await load.commit(async (committedIn) => {
          if (mode === 'reload') await this.#createHidden(connection);
          if (open()) await this.#reload(connection, reloads);
          await claim.claim();
          // The rows of a hidden target were never shown, so only the target
          // keeps the rows a commit replaces.
          let changed = false;
          for (const partition of resets) {
            const { rows, parameters } = this.#within([partition]);
            if (open())
              await connection.query(
                `DELETE FROM ${into()} WHERE ${rows}`,
                parameters,
              );
            else
              changed =
                (await this.history.remove(
                  connection,
                  committedIn,
                  into(),
                  rows,
                  parameters,
                )) > 0 || changed;
          }
          changed =
            (await merge(
              { loadedAt: load.loadedAt, committedIn },
              claim.replaces,
            )) || changed;
          await connection.query(`TRUNCATE TABLE ${stage}`);
          if (!changed) await claim.changedNone(committedIn);
          await this.history.expire(connection);
        });
        claiming = () => claimed;
        // Its first commit made the hidden target, so the reload continues.
        if (mode === 'reload') mode = 'continue';
        committed = { mode, reloads };
        resets = [];
      },
      complete: async () => {
        if (!open()) return;
        await makeSchema(connection, marts);
        await load.commit(async (committedIn) => {
          const target = await fit(this.qualifiedName);
          // A reload of partitions keeps the target's shape: a load whose
          // stored target no longer fits refuses it in prepare.
          let changed = true;
          if (reloads instanceof SomePartitions && target === 'fits')
            changed = await this.#reloadInPlace(
              connection,
              committedIn,
              this.#within(reloads.partitions),
            );
          else if (reloads instanceof SomePartitions)
            throw new TypeError(
              `${this.qualifiedName} changed its shape while some of its partitions reloaded; clear the copy to load it again`,
            );
          else if (target === 'fits')
            changed = await this.#reloadInPlace(connection, committedIn, null);
          else await this.#swap(connection, committedIn);
          await this.#reloaded(connection);
          if (!changed) await forgetCommit(connection, committedIn);
          await this.history.expire(connection);
        });
        mode = 'load';
        reloads = wholeStream;
        committed = { mode, reloads };
      },
      // A RESET that no commit took is undone with the operations after it:
      // the source's checkpoint does not know it.
      discard: async () => {
        await drop();
        ({ mode, reloads } = committed);
      },
      [Symbol.asyncDispose]: async () => {
        await connection.query(
          `DROP TABLE IF EXISTS ${stage}; DROP TABLE IF EXISTS ${reloadStage}`,
        );
      },
    };
  }
}

// What the next commit of a stage does: whether it claims its target, and
// whether it replaces the rows of the target.
type Claim = {
  // Runs before the commit's transaction.
  readonly before: () => Promise<void>;
  // Runs in it, before it merges.
  readonly claim: () => Promise<void>;
  // Runs in it when no reader sees a row change.
  readonly changedNone: (committedIn: number) => Promise<void>;
  readonly replaces: boolean;
};

// The rows of some partitions as a condition, the rows that name none of
// their columns, and the parameters of both.
type Within = {
  readonly rows: string;
  readonly unnamed: string;
  readonly parameters: Readonly<Record<string, string>>;
};

// What each row a commit writes keeps: when its load began, and the number of
// the commit.
export type Written = {
  readonly loadedAt: string;
  readonly committedIn: number;
};

// written as the parameters @loaded and @committed of staged.
export const writtenParameters = ({ loadedAt, committedIn }: Written) => ({
  loaded: loadedAt,
  committed: String(committedIn),
});

// No target of the destination reads files yet, so none keeps a value that
// names one.
const noFiles: FieldValues = (field) => {
  throw new TypeError(`Target field ${field} holds no file`);
};

// Makes the tables of the writers in a transaction of their own, before the
// commits of a load: SQL Server refuses a second session's CREATE TABLE of
// one name, so the lock of _warehouse makes two sessions take turns, and no
// commit holds that lock while it waits for its own target. connection is
// outside any transaction.
async function makeWriterTables(
  connection: SqlServerConnection,
): Promise<void> {
  const [made] = await connection.query(
    `SELECT IIF(OBJECT_ID(N'${writersTable}', N'U') IS NULL OR OBJECT_ID(N'${reloadsTable}', N'U') IS NULL, 0, 1) AS [made]`,
  );
  if (made?.made === 1) return;
  await transaction(connection, async () => {
    await lockSchema(connection, warehouse);
    await connection.query(
      `IF OBJECT_ID(N'${writersTable}', N'U') IS NULL CREATE TABLE ${writersTable} ([target] nvarchar(128) NOT NULL PRIMARY KEY, [writer] nvarchar(max) NOT NULL);
       IF OBJECT_ID(N'${reloadsTable}', N'U') IS NULL CREATE TABLE ${reloadsTable} ([target] nvarchar(128) NOT NULL PRIMARY KEY, [partitions] nvarchar(max) NOT NULL);`,
    );
  });
}
