import { Declaration } from '@zukhruf/sqlite-drift';
import { transaction } from '@zukhruf/sqlite-transaction';

import {
  type Connection,
  DerivedDataset,
  type PipelineClock,
  errorMessage,
} from '@eltjs/elt';
import {
  SQLiteDerivedStatus,
  SQLiteDestination,
  type SQLiteTable,
  openDestination,
  quote,
} from '@eltjs/elt-sqlite';

// The keyword index of the passages of a vectorizer: the table <name> keeps
// the id, source, seq and text of each passage, and the FTS5 table <index>
// indexes its text, as @zukhruf/retrieval's SqliteBM25Retriever reads it
// (its ADR 0004). Triggers keep the index in step with the table, and the
// table, the index and the triggers are one declaration, so a change to any
// of them makes all of them again, and the refill fills the index through the
// insert trigger (ADR 0002). A refresh writes the passages that changed and
// removes the ones that are gone in one transaction, so a reader sees the
// index of one refresh or of the next, never a part of one.
export class KeywordIndex extends DerivedDataset<SQLiteTable> {
  readonly name: string;
  // The FTS5 table, which the passages view joins by rowid.
  readonly index: string;
  readonly #into: SQLiteDestination;
  readonly #parts: string;
  readonly #declaration: Declaration;

  // name: the table of the passages' keywords. index: its FTS5 table. parts:
  // the raw parts table of the chunks, which keeps source, seq and text.
  constructor({
    into,
    name,
    index,
    parts,
  }: {
    into: SQLiteDestination;
    name: string;
    index: string;
    parts: string;
  }) {
    super();
    this.name = name;
    this.index = index;
    this.#into = into;
    this.#parts = parts;
    const table = quote(name);
    const fts = quote(index);
    const removal = `INSERT INTO ${fts} (${fts}, "rowid", "text") VALUES ('delete', old."rowid", old."text");`;
    const addition = `INSERT INTO ${fts} ("rowid", "text") VALUES (new."rowid", new."text");`;
    this.#declaration = new Declaration(
      [
        `CREATE TABLE ${table} ("rowid" INTEGER PRIMARY KEY, "id" TEXT NOT NULL UNIQUE, "source" TEXT NOT NULL, "seq" INTEGER NOT NULL, "text" TEXT NOT NULL, UNIQUE ("source", "seq")) STRICT`,
        `CREATE VIRTUAL TABLE ${fts} USING fts5("text", content = '${name.replaceAll("'", "''")}')`,
        `CREATE TRIGGER ${quote(`${name}_ai`)} AFTER INSERT ON ${table} BEGIN ${addition} END`,
        `CREATE TRIGGER ${quote(`${name}_ad`)} AFTER DELETE ON ${table} BEGIN ${removal} END`,
        `CREATE TRIGGER ${quote(`${name}_au`)} AFTER UPDATE ON ${table} BEGIN ${removal} ${addition} END`,
      ],
      { rows: 'replace' },
    );
    Object.freeze(this);
  }

  override validate(connections: readonly Connection<SQLiteTable>[]): void {
    const made = connections
      .filter(
        ({ destination }) =>
          destination instanceof SQLiteDestination &&
          destination.path === this.#into.path,
      )
      .flatMap(({ steps }) => steps)
      .flatMap(({ to }) => [to.name, to.raw])
      .map((name) => name.toLowerCase());
    for (const name of [this.name, this.index])
      if (made.includes(name.toLowerCase()))
        throw new TypeError(
          `Keyword index ${this.name} needs ${name}, which a copy of the pipeline makes`,
        );
  }

  override async refresh({
    clock,
    signal,
  }: {
    readonly clock: PipelineClock;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    using database = openDestination(this.#into.path);
    const status = new SQLiteDerivedStatus(
      database,
      this.name,
      'computed',
      clock,
    );
    const table = quote(this.name);
    const parts = quote(this.#parts);
    let counts: { readonly inputs: number; readonly computed: number };
    try {
      counts = transaction(
        database,
        () => {
          this.#declaration.apply(database);
          // SQLite parses the ON CONFLICT of an INSERT of a SELECT only after
          // a WHERE.
          database
            .prepare(
              `INSERT INTO ${table} ("id", "source", "seq", "text") SELECT p."source" || ':' || p."seq", p."source", p."seq", p."text" FROM ${parts} AS p WHERE true ON CONFLICT ("id") DO UPDATE SET "text" = excluded."text" WHERE ${table}."text" IS NOT excluded."text"`,
            )
            .run();
          database
            .prepare(
              `DELETE FROM ${table} WHERE NOT EXISTS (SELECT 1 FROM ${parts} AS p WHERE p."source" = ${table}."source" AND p."seq" = ${table}."seq")`,
            )
            .run();
          const row = database
            .prepare(
              `SELECT (SELECT count(*) FROM ${parts}) AS "inputs", (SELECT count(*) FROM ${table}) AS "computed"`,
            )
            .get();
          return {
            inputs: Number(row?.inputs),
            computed: Number(row?.computed),
          };
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      // The chunks have no parts table yet while they wait for their input,
      // so the index waits with them.
      if (this.#missingParts(error)) {
        await status.waiting();
        return;
      }
      // A stop is not the dataset's failure.
      if (signal?.aborted !== true) await status.failed(errorMessage(error));
      throw error;
    }
    await status.current({ ...counts, empty: 0, failed: 0, pending: 0 });
  }

  #missingParts(error: unknown): boolean {
    return (
      Error.isError(error) &&
      /^no such table: (?:main\.)?(.+)$/
        .exec(error.message)?.[1]
        ?.toLowerCase() === this.#parts.toLowerCase()
    );
  }
}
