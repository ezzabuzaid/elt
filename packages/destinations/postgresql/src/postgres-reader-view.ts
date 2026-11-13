import { quote } from './identifier.ts';
import type { TargetComments } from './postgres-comments.ts';
import type { Transaction } from './postgres-load.ts';
import type { PostgresReaderView } from './postgres-table.ts';

// The position a reader reads at: the one a reading set for its
// transaction, or, for a session that set none, past every commit, so the
// view shows the target as it is now and no row of its history.
const position = `coalesce(nullif(current_setting('elt.position', true), '')::integer, 2147483647)`;

// The view readers see a target through: exactly the target's columns,
// loaded_at and committed_in, created with the target and described by the
// same comments. It reads the target as of the position its reader set: the
// rows that the target had then, and that it still has or its history kept.
export class TargetReaderView {
  readonly #view: PostgresReaderView;
  // The target's and its history's qualified names, and the columns the
  // view lists.
  readonly #target: string;
  readonly #history: string;
  readonly #columns: readonly string[];

  constructor(
    view: PostgresReaderView,
    target: string,
    history: string,
    columns: readonly string[],
  ) {
    this.#view = view;
    this.#target = target;
    this.#history = history;
    this.#columns = columns;
    Object.freeze(this);
  }

  get qualifiedName(): string {
    return `${quote(this.#view.schema)}.${quote(this.#view.name)}`;
  }

  // Refuses, before anything is read, a reader view this load did not make:
  // not a view, or a view of other columns or another table. A stale
  // target's view still shows the stored columns, which evolving it replaces.
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
    if (existing?.exists !== true) {
      const columns = this.#columns.map(quote);
      await sql.unsafe(
        `CREATE VIEW ${view} AS SELECT ${columns.join(', ')} FROM ${this.#target} WHERE "committed_in" <= ${position} UNION ALL SELECT ${columns.join(', ')} FROM ${this.#history} AS "_elt_old" WHERE "_elt_old"."committed_in" <= ${position} AND "_elt_old"."replaced_in" > ${position}`,
      );
    }
    await comments.write(sql, 'VIEW', this.#view.schema, this.#view.name);
  }

  async drop(sql: Transaction): Promise<void> {
    await sql.unsafe(`DROP VIEW IF EXISTS ${this.qualifiedName}`);
  }
}
