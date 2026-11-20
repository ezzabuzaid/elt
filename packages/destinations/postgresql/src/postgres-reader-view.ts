import { quote } from './identifier.ts';
import type { TargetComments } from './postgres-comments.ts';
import type { Transaction } from './postgres-load.ts';
import { inMarts, marts } from './postgres-schemas.ts';

// The position a reader reads at: the one a reading set for its
// transaction, or, for a session that set none, past every commit, so the
// view shows the target as it is now and no row of its history.
const position = `coalesce(nullif(current_setting('elt.position', true), '')::integer, 2147483647)`;

// The view in marts that readers see a target through: exactly the stream's
// columns and loaded_at, none of the internal ones, created with the target
// and described by the comments of those columns. It reads the target as of the
// position its reader set: the rows that the target had then, and that it
// still has or its history kept.
export class TargetReaderView {
  readonly #name: string;
  // The target's and its history's qualified names, and the columns the
  // view lists, with their comments.
  readonly #target: string;
  readonly #history: string;
  readonly #columns: readonly string[];
  readonly #comments: TargetComments;

  constructor(
    name: string,
    target: string,
    history: string,
    columns: readonly string[],
    comments: TargetComments,
  ) {
    this.#name = name;
    this.#target = target;
    this.#history = history;
    this.#columns = columns;
    this.#comments = comments;
    Object.freeze(this);
  }

  get qualifiedName(): string {
    return inMarts(this.#name);
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
  async describe(sql: Transaction): Promise<void> {
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
    await this.#comments.write(sql, 'VIEW', marts, this.#name);
  }

  async drop(sql: Transaction): Promise<void> {
    await sql.unsafe(`DROP VIEW IF EXISTS ${this.qualifiedName}`);
  }
}
