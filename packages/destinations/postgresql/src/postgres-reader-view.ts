import { quote } from './identifier.ts';
import type { TargetComments } from './postgres-comments.ts';
import type { Transaction } from './postgres-load.ts';
import type { PostgresReaderView } from './postgres-table.ts';

// The view readers see a target through: exactly the target's columns and
// loaded_at, created with the target and described by the same comments.
export class TargetReaderView {
  readonly #view: PostgresReaderView;
  // The target's qualified name, and its columns as the view lists them.
  readonly #target: string;
  readonly #columns: readonly string[];
  readonly #fields: readonly string[];

  constructor(
    view: PostgresReaderView,
    target: string,
    columns: readonly string[],
    fields: readonly string[],
  ) {
    this.#view = view;
    this.#target = target;
    this.#columns = columns;
    this.#fields = fields;
    Object.freeze(this);
  }

  get qualifiedName(): string {
    return `${quote(this.#view.schema)}.${quote(this.#view.name)}`;
  }

  // Refuses, before anything is read, a reader view this load did not make:
  // not a view, or a view of other columns or another table. A stale
  // target's view still shows the stored columns, which its rebuild replaces.
  async refuse(sql: Transaction, stale: boolean): Promise<void> {
    const view = this.qualifiedName;
    const [existing] = await sql.unsafe<
      { relkind: string; columns: string[]; reads: boolean }[]
    >(
      `SELECT c.relkind,
         ARRAY(SELECT attname::text FROM pg_attribute
           WHERE attrelid = c.oid AND attnum > 0 AND NOT attisdropped ORDER BY attnum) AS columns,
         EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_depend d
           ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
           WHERE r.ev_class = c.oid AND d.refobjid = to_regclass($2)) AS reads
       FROM pg_class c WHERE c.oid = to_regclass($1)`,
      [view, this.#target],
    );
    if (existing === undefined) return;
    if (
      existing.relkind !== 'v' ||
      !existing.reads ||
      (!stale && existing.columns.join('\0') !== this.#columns.join('\0'))
    )
      throw new TypeError(
        `${view} is not a view of exactly ${this.#target}; drop it or reset the warehouse`,
      );
  }

  // Created only when absent and never replaced by a commit: replacing a view
  // readers can see would lock them out. prepare refused any view not this
  // load's own.
  async describe(sql: Transaction, comments: TargetComments): Promise<void> {
    const view = this.qualifiedName;
    const [existing] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [view],
    );
    if (existing?.exists !== true)
      await sql.unsafe(
        `CREATE VIEW ${view} AS SELECT ${this.#fields.join(', ')} FROM ${this.#target}`,
      );
    await comments.write(sql, 'VIEW', this.#view.schema, this.#view.name);
  }

  async drop(sql: Transaction): Promise<void> {
    await sql.unsafe(`DROP VIEW IF EXISTS ${this.qualifiedName}`);
  }
}
