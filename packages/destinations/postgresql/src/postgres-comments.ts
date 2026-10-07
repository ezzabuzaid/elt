import type { Transaction } from './postgres-load.ts';

// A target's descriptions as Postgres keeps them: one comment on the table or
// its view, and one on each column.
export class TargetComments {
  readonly #table: string;
  readonly #columns: Readonly<Record<string, string | null>>;

  constructor(table: string, columns: Readonly<Record<string, string | null>>) {
    this.#table = table;
    this.#columns = columns;
    Object.freeze(this);
  }

  // COMMENT does not accept bind parameters. Let Postgres quote identifiers
  // and literals, including NULL to clear annotations removed from the schema.
  async write(
    sql: Transaction,
    kind: 'TABLE' | 'VIEW',
    schema: string,
    name: string,
  ): Promise<void> {
    const comments = await sql.unsafe<{ statement: string }[]>(
      `SELECT format('COMMENT ON ${kind} %I.%I IS %L', $1::text, $2::text, $3::text) AS statement
       UNION ALL
       SELECT format('COMMENT ON COLUMN %I.%I.%I IS %L', $1::text, $2::text, key, value)
       FROM jsonb_each_text($4::jsonb)`,
      [schema, name, this.#table, sql.json(this.#columns)],
    );
    await sql.unsafe(comments.map(({ statement }) => statement).join(';'));
  }
}
