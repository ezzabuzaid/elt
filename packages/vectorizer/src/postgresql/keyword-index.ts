import { hash } from 'node:crypto';

import postgres from 'postgres';

import {
  type Connection,
  DerivedDataset,
  type PipelineClock,
  errorMessage,
} from '@eltjs/elt';
import {
  PostgresDerivedStatus,
  PostgresDestination,
  type PostgresTable,
  inWarehouse,
  quote,
  rawTable,
  warehouse,
} from '@eltjs/elt-postgresql';

import { copiesInto } from '../copies.ts';

// The keyword index of the passages of a vectorizer: the table
// _warehouse.raw_<name> keeps the id, source, seq and text of each passage,
// and its keywords column, the tsvector that Postgres generates from the text
// with the text search configuration, which a GIN index indexes, as
// @zukhruf/retrieval's PgvectorKeywordRetriever reads it (its ADR 0004). The
// table and its index are one declaration, whose hash the table keeps as its
// comment: a change of the declaration, such as another configuration, drops
// the table, and each view over it, and makes it again, and the refill gives
// each passage its keywords in the new configuration (ADR 0002). A refresh
// writes the passages that changed and removes the ones that are gone in one
// transaction, so a reader sees the index of one refresh or of the next,
// never a part of one.
export class KeywordIndex extends DerivedDataset<PostgresTable> {
  readonly name: string;
  // The table of the index, which the passages view reads, and which a view
  // after it waits for while the index waits.
  readonly qualifiedName: string;
  readonly #into: PostgresDestination;
  readonly #table: string;
  readonly #parts: string;
  readonly #partsTable: string;
  readonly #declaration: readonly string[];
  readonly #declared: string;

  // name: the name of the index, whose table is raw_<name>. parts: the raw
  // parts table of the chunks, which keeps source, seq and text, in
  // _warehouse. configuration: the text search configuration of the
  // keywords.
  constructor({
    into,
    name,
    parts,
    configuration,
  }: {
    into: PostgresDestination;
    name: string;
    parts: string;
    configuration: string;
  }) {
    super();
    this.name = name;
    this.#into = into;
    const raw = rawTable(name);
    this.#table = raw;
    this.qualifiedName = `${warehouse}.${raw}`;
    this.#parts = inWarehouse(parts);
    this.#partsTable = `${warehouse}.${parts}`;
    const table = inWarehouse(raw);
    this.#declaration = Object.freeze([
      `CREATE TABLE ${table} ("id" text COLLATE "C" PRIMARY KEY, "source" text NOT NULL, "seq" integer NOT NULL, "text" text NOT NULL, "keywords" tsvector GENERATED ALWAYS AS (to_tsvector('${configuration.replaceAll("'", "''")}'::regconfig, "text")) STORED, UNIQUE ("source", "seq"))`,
      `CREATE INDEX ${quote(`${raw}_gin`)} ON ${table} USING gin ("keywords")`,
    ]);
    this.#declared = hash('sha256', this.#declaration.join(';\n'));
    Object.freeze(this);
  }

  override validate(connections: readonly Connection<PostgresTable>[]): void {
    const made = copiesInto(
      connections,
      (destination) =>
        destination instanceof PostgresDestination &&
        destination.url === this.#into.url,
    ).map(({ to }) => to.raw);
    if (made.includes(this.#table))
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
    await using stack = new AsyncDisposableStack();
    const sql = postgres(this.#into.url, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: 'elt-derived' },
    });
    stack.defer(() => sql.end({ timeout: 5 }));
    const status = new PostgresDerivedStatus(
      sql,
      this.qualifiedName,
      'computed',
      clock,
    );
    const table = inWarehouse(this.#table);
    const parts = this.#parts;
    let counts: { readonly inputs: number; readonly computed: number };
    try {
      counts = await sql.begin(async (transaction) => {
        // Two refreshes of one index take turns, so neither makes the table
        // while the other makes it.
        await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${`elt:${this.qualifiedName}`}, 0))`;
        const [stored] = await transaction<{ declared: string | null }[]>`
          SELECT obj_description(to_regclass(${this.qualifiedName}), 'pg_class') AS "declared"`;
        if (stored?.declared !== this.#declared) {
          await transaction.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
          for (const statement of this.#declaration)
            await transaction.unsafe(statement);
          await transaction.unsafe(
            `COMMENT ON TABLE ${table} IS '${this.#declared}'`,
          );
        }
        await transaction.unsafe(
          `INSERT INTO ${table} ("id", "source", "seq", "text") SELECT p."source" || ':' || p."seq", p."source", p."seq", p."text" FROM ${parts} AS p ON CONFLICT ("id") DO UPDATE SET "text" = excluded."text" WHERE ${table}."text" IS DISTINCT FROM excluded."text"`,
        );
        await transaction.unsafe(
          `DELETE FROM ${table} AS k WHERE NOT EXISTS (SELECT 1 FROM ${parts} AS p WHERE p."source" = k."source" AND p."seq" = k."seq")`,
        );
        const [row] = await transaction.unsafe<
          { inputs: number; computed: number }[]
        >(
          `SELECT (SELECT count(*) FROM ${parts})::int AS "inputs", (SELECT count(*) FROM ${table})::int AS "computed"`,
        );
        return { inputs: Number(row?.inputs), computed: Number(row?.computed) };
      });
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
      error instanceof postgres.PostgresError &&
      error.code === '42P01' &&
      error.message === `relation "${this.#partsTable}" does not exist`
    );
  }
}
