import { hash } from 'node:crypto';

import {
  type Clearing,
  type CopyConfiguration,
  type FieldValues,
  type Stage,
  TargetOwnedError,
  Writer,
  describeTarget,
  reloadMode,
} from '@eltjs/elt';
import type {
  SqlServerConnection,
  SqlServerDatabase,
} from '@eltjs/sdk-microsoft-sql-server';

import {
  connect,
  lockSchema,
  makeSchema,
  transaction,
} from './sql-server-connection.ts';
import { TargetDescriptions } from './sql-server-descriptions.ts';
import { storedFit } from './sql-server-fit.ts';
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
const seq = '[_elt_seq]';
const version = '[_elt_row_hash]';
const keyHash = '[_elt_key_hash]';

// The table in _warehouse where each writer keeps the owner of its target.
const writersTable = inWarehouse('_elt_writers');

// Appends each record of a stream to its raw table, in the order the source
// gave them. Each row is told apart by _elt_row, its identity number, the
// clustered key of the table (ADR 0003).
export class SqlServerWriter extends Writer {
  readonly configuration: CopyConfiguration;
  readonly table: SqlServerTable;
  readonly #database: SqlServerDatabase;
  readonly #retention: Temporal.Duration;
  readonly #history: TargetHistory;
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
    this.#history = new TargetHistory(this.#hash);
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
      this.#history.qualifiedName,
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

  // The key hash of a table whose columns declare a key, as its only
  // element: a key column of nvarchar(max) cannot be an index key, and its
  // collation would take two keys that differ in case for one (ADR 0004).
  get #keyHashes(): readonly string[] {
    return this.table.columns.some(({ isPrimaryKey }) => isPrimaryKey)
      ? [keyHash]
      : [];
  }

  // A table named name with the target's columns, clustered on its row
  // number.
  #tableSQL(name: string): string {
    if (this.table.columns.length === 0)
      throw new TypeError('Resolve inferred columns before creating a table');
    return `${name} ([_elt_row] bigint IDENTITY(1, 1) NOT NULL PRIMARY KEY CLUSTERED, ${[
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
         ${this.#keyHashes.map((column) => `CREATE UNIQUE INDEX ${quote(`_elt_key_${this.#hash}`)} ON ${this.qualifiedName} (${column});`).join('')}
       END`,
      { table: this.qualifiedName },
    );
    await this.#history.create(connection, this.qualifiedName);
    await this.#descriptions.write(
      connection,
      'TABLE',
      warehouse,
      this.table.raw,
    );
    await this.#view.describe(connection);
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
    await makeWriterTable(connection);
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
        await this.#history.expire(connection);
      }
      await connection.query(
        `DELETE FROM ${writersTable} WHERE [target] = @target`,
        { target: this.table.raw },
      );
    });
    await committed?.(noFiles);
  }

  // One stream's load. Operations wait in a #temp table of the load's
  // connection, so no other session sees them and a crash leaves nothing
  // behind. prepare only refuses and stages, so a run that fails before a
  // commit leaves no rows behind. Each commit is one transaction that appends
  // the stage to the table; the first commit also makes the table.
  async prepare(
    load: SqlServerLoad,
    { writer, reloading }: { writer: string; reloading: boolean },
  ): Promise<Stage> {
    const { connection } = load;
    const stage = `#elt_stage_${this.#hash}`;
    const { columns } = this.table;
    await makeWriterTable(connection);
    // A #temp table that a batch with parameters makes is dropped at the end
    // of that batch, so the stage is made by a batch with none.
    await connection.query(
      `DROP TABLE IF EXISTS ${stage}; CREATE TABLE ${stage} (${[
        `${seq} bigint NOT NULL PRIMARY KEY`,
        ...columns.map(
          (column) => `${column.quotedName} ${column.storageType} NULL`,
        ),
        ...[version, ...this.#keyHashes].map(
          (column) => `${column} binary(32) NULL`,
        ),
      ].join(', ')})`,
    );
    const mode = await load.transaction(async () => {
      await this.#refuse(connection, writer);
      const target = await storedFit(
        connection,
        this.table,
        this.qualifiedName,
        stage,
      );
      await this.#view.refuse(connection, target === 'stale');
      return reloadMode({
        reloading,
        destinationSyncMode: this.configuration.destinationSyncMode,
        target,
        hidden: 'missing',
      });
    });
    if (mode !== 'create' && mode !== 'load')
      throw new TypeError(
        `${this.qualifiedName} no longer has the shape of stream ${this.stream.name}, and the SQL Server destination does not evolve or reload a stored table yet; clear the copy to load it again`,
      );
    // Each staged row as JSON: its place in the stream, its values, and the
    // hashes, as hex, which the stage keeps as binary(32).
    const hashes = [version, ...this.#keyHashes];
    const insert = `INSERT INTO ${stage} (${[seq, ...columns.map((column) => column.quotedName), ...hashes].join(', ')})
      SELECT ${['j.[s]', ...columns.map((column, index) => column.stored(`j.[v${index}]`)), ...hashes.map((_, index) => `CONVERT(binary(32), j.[h${index}], 2)`)].join(', ')}
      FROM OPENJSON(@batch) WITH (${[
        `[s] bigint '$[0]'`,
        ...columns.map(
          (column, index) =>
            `[v${index}] ${column.batchType} '$[${index + 1}]'${column.array ? ' AS JSON' : ''}`,
        ),
        ...hashes.map(
          (_, index) =>
            `[h${index}] char(64) '$[${columns.length + 1 + index}]'`,
        ),
      ].join(', ')}) AS j`;
    const keyed = columns.flatMap((column, index) =>
      column.isPrimaryKey ? [index] : [],
    );
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
    // The first commit claims the target: before its transaction it makes
    // marts for the reader view, and in it the table, which is a change even
    // with no row. Later commits find it claimed, and a commit of a claimed
    // target that appends no row takes back its commit row.
    const unclaimed: Claim = {
      before: () => makeSchema(connection, marts),
      claim: () => this.#create(connection, writer),
      appendedNone: async () => {},
    };
    const claimed: Claim = {
      before: async () => {},
      claim: async () => {},
      appendedNone: (committedIn) => forgetCommit(connection, committedIn),
    };
    let claiming = mode === 'load' ? claimed : unclaimed;
    return {
      fresh: mode === 'create',
      reloading: false,
      values: noFiles,
      apply: async (operation) => {
        if (operation.type === 'DELETE')
          throw new TypeError('Only deduplicating loads can apply deletions');
        if (operation.type === 'RESET')
          throw new TypeError(
            'The SQL Server destination does not reload a stream yet',
          );
        const row = columns.map((column) => column.encode(operation.data));
        const text = JSON.stringify([
          next++,
          ...row,
          rowHash(columns, row),
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
        await claiming.before();
        await load.commit(async (committedIn) => {
          await claiming.claim();
          const [appended] = await connection.query(
            `INSERT INTO ${this.qualifiedName} (${[...columns.map((column) => column.quotedName), '[loaded_at]', '[committed_in]', ...hashes].join(', ')})
             SELECT ${[...columns.map((column) => column.quotedName), 'CAST(@loaded AS datetimeoffset(3))', 'CAST(@committed AS bigint)', ...hashes].join(', ')} FROM ${stage} ORDER BY ${seq};
             SELECT @@ROWCOUNT AS [rows];
             TRUNCATE TABLE ${stage};`,
            { loaded: load.loadedAt, committed: String(committedIn) },
          );
          if (appended?.rows === 0) await claiming.appendedNone(committedIn);
          await this.#history.expire(connection);
        });
        claiming = claimed;
      },
      complete: async () => {},
      discard: async () => {
        pending = [];
        pendingBytes = 0;
        await connection.query(`TRUNCATE TABLE ${stage}`);
      },
      [Symbol.asyncDispose]: async () => {
        await connection.query(`DROP TABLE IF EXISTS ${stage}`);
      },
    };
  }
}

// Whether a stage's commit claims its target.
type Claim = {
  // Runs before the commit's transaction.
  readonly before: () => Promise<void>;
  // Runs in it, before it appends.
  readonly claim: () => Promise<void>;
  // Runs in it when it appended no row.
  readonly appendedNone: (committedIn: number) => Promise<void>;
};

// No target of the destination reads files yet, so none keeps a value that
// names one.
const noFiles: FieldValues = (field) => {
  throw new TypeError(`Target field ${field} holds no file`);
};

// Makes the table of the writers in a transaction of its own, before the
// commits of a load: SQL Server refuses a second session's CREATE TABLE of
// one name, so the lock of _warehouse makes two sessions take turns, and no
// commit holds that lock while it waits for its own target. connection is
// outside any transaction.
async function makeWriterTable(connection: SqlServerConnection): Promise<void> {
  const [made] = await connection.query(
    `SELECT IIF(OBJECT_ID(N'${writersTable}', N'U') IS NULL, 0, 1) AS [made]`,
  );
  if (made?.made === 1) return;
  await transaction(connection, async () => {
    await lockSchema(connection, warehouse);
    await connection.query(
      `IF OBJECT_ID(N'${writersTable}', N'U') IS NULL CREATE TABLE ${writersTable} ([target] nvarchar(128) NOT NULL PRIMARY KEY, [writer] nvarchar(max) NOT NULL)`,
    );
  });
}
