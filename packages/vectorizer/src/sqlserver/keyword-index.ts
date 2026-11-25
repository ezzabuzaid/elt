import { hash } from 'node:crypto';

import { poll } from '@zukhruf/async';

import {
  type Connection,
  DerivedDataset,
  type PipelineClock,
  errorMessage,
} from '@eltjs/elt';
import {
  SqlServerDerivedStatus,
  type SqlServerDestination,
  SqlServerSetupError,
  type SqlServerTable,
  connectDestination,
  inMarts,
  inWarehouse,
  literal,
  marts,
  quote,
  sameDatabase,
  warehouse,
} from '@eltjs/elt-sqlserver';

import { copiesInto } from '../copies.ts';

type Session = Awaited<ReturnType<typeof connectDestination>>;

// The collation of every passage id and source: UTF-16 code units, so a and A
// are two passages under a case-insensitive database, as @zukhruf/retrieval
// compares them.
const binary = 'Latin1_General_100_BIN2';

// The most characters of a passage id: a full-text key holds at most 900
// bytes, and NVARCHAR keeps two bytes for each UTF-16 unit. The chunks of the
// vectorizer fail an input whose ids are longer, so no part of it reaches
// the index.
export const mostIdCharacters = 450;

// The error of a full-text statement on a server with no Full-Text Search
// (Microsoft, "Database engine events and errors 7000 to 7999": "Full-Text
// Search is not installed, or a full-text component cannot be loaded.").
const noFullTextSearch = 7609;

// The error of a relation that no schema has.
const invalidObject = 208;

// How long the member waits between two reads of the state of the full-text
// index.
const populationPoll = 250;

const numberOf = (error: unknown) =>
  Error.isError(error) && 'number' in error ? error.number : undefined;

// The keyword index of the passages of a vectorizer on SQL Server: the base
// table marts.<name> keeps the id, source, seq and text of each passage, and
// a full-text index on its text, with the id as its key, is what
// @zukhruf/retrieval's SqlServerKeywordRetriever reads through CONTAINSTABLE
// (its ADR 0004). The table is in marts, so a reader with SELECT on marts
// searches it (ADR 0002). SQL Server makes a full-text catalog and index only
// outside a transaction (error 574), so the member makes them as statements
// of their own, and the table keeps the hash of its declaration as the
// extended property elt_declaration: another declaration, such as another
// language, makes the table and its index again, and the refill gives each
// passage to the new index. A refresh writes the passages in one MERGE, then
// waits until the index has no population running and no change waiting, so
// current means that a search finds each passage.
export class KeywordIndex extends DerivedDataset<SqlServerTable> {
  readonly name: string;
  // The table, which the passages view reads, and which a view after it
  // waits for while the index waits.
  readonly qualifiedName: string;
  readonly #into: SqlServerDestination;
  readonly #table: string;
  readonly #parts: string;
  readonly #partsName: string;
  readonly #catalog: string;
  readonly #declaration: readonly string[];
  readonly #declared: string;

  // name: the table of the passages' keywords in marts. parts: the raw parts
  // table of the chunks in _warehouse, which keeps source, seq and text.
  // language: the LCID of the word breaker of the full-text index, such as
  // 1033 for English.
  constructor({
    into,
    name,
    parts,
    language,
  }: {
    into: SqlServerDestination;
    name: string;
    parts: string;
    language: number;
  }) {
    super();
    if (!Number.isSafeInteger(language) || language < 0)
      throw new RangeError(
        `Keyword index ${name} needs the LCID of a language, an integer of 0 or more; it got ${language}`,
      );
    this.name = name;
    this.qualifiedName = `${marts}.${name}`;
    this.#into = into;
    this.#table = inMarts(name);
    this.#parts = inWarehouse(parts);
    this.#partsName = `${warehouse}.${parts}`;
    this.#catalog = quote(name);
    const key = quote(
      `pk_elt_${hash('sha256', this.qualifiedName).slice(0, 16)}`,
    );
    this.#declaration = Object.freeze([
      `CREATE TABLE ${this.#table} ([id] NVARCHAR(${mostIdCharacters}) COLLATE ${binary} NOT NULL CONSTRAINT ${key} PRIMARY KEY, [source] NVARCHAR(${mostIdCharacters}) COLLATE ${binary} NOT NULL, [seq] INT NOT NULL, [text] NVARCHAR(MAX) NOT NULL)`,
      `CREATE FULLTEXT INDEX ON ${this.#table} ([text] LANGUAGE ${language}) KEY INDEX ${key} ON ${this.#catalog} WITH STOPLIST = OFF, CHANGE_TRACKING AUTO`,
    ]);
    this.#declared = hash('sha256', this.#declaration.join(';\n'));
    Object.freeze(this);
  }

  override validate(connections: readonly Connection<SqlServerTable>[]): void {
    const made = copiesInto(connections, (destination) =>
      sameDatabase(destination, this.#into),
    ).map(({ to }) => `${marts}.${to.name}`.toLowerCase());
    if (made.includes(this.qualifiedName.toLowerCase()))
      throw new TypeError(
        `Keyword index ${this.name} needs ${this.qualifiedName}, which a copy of the pipeline makes`,
      );
  }

  override async refresh({
    clock,
    signal,
  }: {
    readonly clock: PipelineClock;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    await using session = await connectDestination(this.#into, clock);
    const status = new SqlServerDerivedStatus(
      session,
      this.qualifiedName,
      'computed',
      clock,
    );
    try {
      // The chunks have no parts table yet while they wait for their input,
      // so the index waits with them, and makes nothing.
      try {
        await session.query(`SELECT TOP (0) 1 AS [part] FROM ${this.#parts}`);
      } catch (error) {
        if (!this.#missingParts(error)) throw error;
        await status.waiting();
        return;
      }
      // Two refreshes of one index take turns, so neither makes the table
      // while the other makes it. The lock is the session's, since the
      // full-text statements run outside a transaction; it ends with the
      // session.
      await session.query(
        `DECLARE @result int;
         EXEC @result = sp_getapplock @Resource = @resource, @LockMode = N'Exclusive', @LockOwner = N'Session', @LockTimeout = -1;
         IF @result < 0 THROW 50000, N'The lock was not granted', 1;`,
        { resource: `elt:${this.qualifiedName}` },
      );
      await this.#declare(session);
      const counts = await this.#write(session);
      await status.refreshing({ ...counts, empty: 0, failed: 0, pending: 0 });
      await this.#populated(session, clock, signal);
      await status.current({ ...counts, empty: 0, failed: 0, pending: 0 });
    } catch (error) {
      // A stop is not the dataset's failure.
      if (signal?.aborted !== true) await status.failed(errorMessage(error));
      throw error;
    }
  }

  // Makes the catalog when the database has none, and the table and its
  // full-text index again when the table does not keep the hash of this
  // declaration or has no full-text index. A server with no Full-Text Search
  // refuses the catalog, before the member makes anything.
  async #declare(session: Session): Promise<void> {
    try {
      await session.query(
        `IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE [name] = ${literal(this.name)}) CREATE FULLTEXT CATALOG ${this.#catalog}`,
      );
    } catch (error) {
      if (numberOf(error) !== noFullTextSearch) throw error;
      throw new SqlServerSetupError(
        `Keyword index ${this.name} needs Full-Text Search, and the server has none: install it (on Linux, the package mssql-server-fts), or use Azure SQL Database, which has it`,
        { cause: error },
      );
    }
    const [stored] = await session.query(
      `SELECT (SELECT CAST([value] AS nvarchar(100)) FROM sys.extended_properties WHERE [class] = 1 AND [major_id] = OBJECT_ID(@table) AND [minor_id] = 0 AND [name] = N'elt_declaration') AS [declared],
              (SELECT COUNT(*) FROM sys.fulltext_indexes WHERE [object_id] = OBJECT_ID(@table)) AS [indexed]`,
      { table: this.#table },
    );
    if (stored?.declared === this.#declared && Number(stored.indexed) === 1)
      return;
    await session.query(
      `IF EXISTS (SELECT 1 FROM sys.fulltext_indexes WHERE [object_id] = OBJECT_ID(${literal(this.#table)})) DROP FULLTEXT INDEX ON ${this.#table}`,
    );
    await session.query(`DROP TABLE IF EXISTS ${this.#table}`);
    for (const statement of this.#declaration) await session.query(statement);
    // Last, so a make that stopped half way is made again by the next
    // refresh.
    await session.query(
      `EXEC sp_addextendedproperty @name = N'elt_declaration', @value = @declared, @level0type = N'SCHEMA', @level0name = @schema, @level1type = N'TABLE', @level1name = @table`,
      { declared: this.#declared, schema: marts, table: this.name },
    );
  }

  // Writes each passage whose text changed and removes each one that no part
  // has, in one MERGE, and gives the parts and the passages.
  async #write(
    session: Session,
  ): Promise<{ readonly inputs: number; readonly computed: number }> {
    await session.query(
      `MERGE ${this.#table} AS k
         USING (SELECT CONCAT(p.[source], N':', p.[seq]) COLLATE ${binary} AS [id], p.[source], p.[seq], p.[text] FROM ${this.#parts} AS p) AS n
         ON k.[id] = n.[id]
         WHEN MATCHED AND k.[text] COLLATE ${binary} <> n.[text] COLLATE ${binary} THEN UPDATE SET [text] = n.[text]
         WHEN NOT MATCHED BY TARGET THEN INSERT ([id], [source], [seq], [text]) VALUES (n.[id], n.[source], n.[seq], n.[text])
         WHEN NOT MATCHED BY SOURCE THEN DELETE;`,
    );
    const [row] = await session.query(
      `SELECT (SELECT COUNT_BIG(*) FROM ${this.#parts}) AS [inputs], (SELECT COUNT_BIG(*) FROM ${this.#table}) AS [computed]`,
    );
    return { inputs: Number(row?.inputs), computed: Number(row?.computed) };
  }

  // Waits on the clock of the pipeline, under the signal of the refresh,
  // until the full-text index has no population running and no change
  // waiting. Both are needed: no change waits while the first population
  // still runs. OBJECTPROPERTYEX gives a sql_variant, so each is cast.
  async #populated(
    session: Session,
    clock: PipelineClock,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await poll(
      async () => {
        const [state] = await session.query(
          `SELECT CAST(OBJECTPROPERTYEX(OBJECT_ID(@table), 'TableFulltextPopulateStatus') AS INT) AS [populating],
                  CAST(OBJECTPROPERTYEX(OBJECT_ID(@table), 'TableFulltextPendingChanges') AS INT) AS [pending]`,
          { table: this.#table },
          { signal },
        );
        return Number(state?.populating) === 0 && Number(state?.pending) === 0
          ? true
          : undefined;
      },
      { interval: populationPoll, signal, clock },
    );
  }

  #missingParts(error: unknown): boolean {
    return (
      numberOf(error) === invalidObject &&
      Error.isError(error) &&
      error.message.toLowerCase() ===
        `invalid object name '${this.#partsName}'.`.toLowerCase()
    );
  }
}
