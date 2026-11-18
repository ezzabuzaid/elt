import { errorMessage } from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { Transaction } from './postgres-load.ts';
import { Privileges } from './postgres-privileges.ts';

// A view, or a materialized view, as it stood before a change, with what
// makes it again: its definition with every name qualified, its options and
// indexes, its owner, and its comments.
type SavedView = {
  readonly relation: string;
  readonly kind: 'VIEW' | 'MATERIALIZED VIEW';
  readonly definition: string;
  readonly options: string | null;
  readonly populated: boolean;
  readonly owner: string;
  readonly description: string | null;
  readonly columns: readonly {
    readonly name: string;
    readonly description: string;
  }[];
  readonly indexes: readonly string[];
};

// Each view that reads one of the roots, directly or through other views,
// deepest last. A view's own rule depends on the view, which is not a reader
// of it.
const dependents = `
  WITH RECURSIVE roots AS (
    SELECT to_regclass(name) AS oid FROM unnest($1::text[]) AS name
    WHERE to_regclass(name) IS NOT NULL
  ), readers AS (
    SELECT r.ev_class AS oid, 1 AS depth
    FROM pg_depend d JOIN pg_rewrite r
      ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
    WHERE d.refclassid = 'pg_class'::regclass
      AND d.refobjid IN (SELECT oid FROM roots) AND r.ev_class <> d.refobjid
    UNION ALL
    SELECT r.ev_class, readers.depth + 1
    FROM readers JOIN pg_depend d
      ON d.refclassid = 'pg_class'::regclass AND d.refobjid = readers.oid
    JOIN pg_rewrite r ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
    WHERE r.ev_class <> readers.oid
  )
  SELECT format('%I.%I', n.nspname, c.relname) AS "relation",
    CASE c.relkind WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'VIEW' END AS "kind",
    pg_get_viewdef(c.oid) AS "definition",
    array_to_string(c.reloptions, ', ') AS "options",
    c.relispopulated AS "populated",
    pg_get_userbyid(c.relowner) AS "owner",
    obj_description(c.oid, 'pg_class') AS "description",
    coalesce((SELECT json_agg(json_build_object('name', a.attname,
        'description', col_description(c.oid, a.attnum)) ORDER BY a.attnum)
      FROM pg_attribute a
      WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND col_description(c.oid, a.attnum) IS NOT NULL), '[]') AS "columns",
    coalesce((SELECT json_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid)
      FROM pg_index i WHERE i.indrelid = c.oid), '[]') AS "indexes"
  FROM (SELECT oid, max(depth) AS depth FROM readers
        WHERE oid NOT IN (SELECT oid FROM roots) GROUP BY oid) v
  JOIN pg_class c ON c.oid = v.oid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  ORDER BY v.depth, c.oid`;

// Runs change, which Postgres would refuse under the views that read roots:
// it binds a view to the relations it read when it was made, so DROP TABLE,
// ALTER COLUMN TYPE, DROP COLUMN and DROP VIEW fail while one reads them.
// The views are saved, dropped, and made again over what the change left,
// by name, in the same transaction, so a reader never finds one missing:
// each takes the relation that now has the name it reads, as a view of
// Snowflake or BigQuery, or a Redshift view WITH NO SCHEMA BINDING, resolves
// its tables at each query (pg-deps-management's save and restore). A view
// that does not fit what the change left, such as one that reads a column
// the change dropped, fails the change and names the view. The roots are the
// change's own, which it can make again, such as a table it swaps in; each
// root that existed keeps its privileges in the relation that has its name
// after the change.
export async function rebindDependents<T>(
  sql: Transaction,
  roots: readonly string[],
  change: () => Promise<T>,
): Promise<T> {
  // Every name qualified, so each view reads the same names again.
  const [{ path } = { path: '' }] = await sql.unsafe<{ path: string }[]>(
    "SELECT current_setting('search_path') AS path",
  );
  await sql.unsafe("SELECT set_config('search_path', '', true)");
  const saved = await sql.unsafe<SavedView[]>(dependents, [roots]);
  const existing = await sql.unsafe<{ relation: string }[]>(
    'SELECT relation FROM unnest($1::text[]) AS relation WHERE to_regclass(relation) IS NOT NULL',
    [roots],
  );
  const privileges = new Map<string, Privileges>();
  for (const { relation } of [...existing, ...saved])
    privileges.set(relation, await Privileges.of(sql, relation));
  await sql.unsafe("SELECT set_config('search_path', $1, true)", [path]);
  for (const view of saved.toReversed())
    try {
      await sql.unsafe(`DROP ${view.kind} ${view.relation}`);
    } catch (cause) {
      throw new TypeError(
        `${view.relation} reads ${roots[0]}, and an object that elt cannot make again reads ${view.relation}: ${errorMessage(cause)}`,
        { cause },
      );
    }
  const result = await change();
  await sql.unsafe("SELECT set_config('search_path', '', true)");
  for (const view of saved)
    try {
      await make(sql, view);
    } catch (cause) {
      throw new TypeError(
        `${view.relation} reads ${roots[0]} and does not fit its change: ${errorMessage(cause)}. Change the view, or drop it.`,
        { cause },
      );
    }
  for (const [relation, kept] of privileges) await kept.apply(sql, relation);
  await sql.unsafe("SELECT set_config('search_path', $1, true)", [path]);
  return result;
}

async function make(sql: Transaction, view: SavedView): Promise<void> {
  const options = view.options === null ? '' : ` WITH (${view.options})`;
  let data = '';
  if (view.kind === 'MATERIALIZED VIEW')
    data = view.populated ? ' WITH DATA' : ' WITH NO DATA';
  await sql.unsafe(
    `CREATE ${view.kind} ${view.relation}${options} AS ${view.definition.replace(/;\s*$/, '')}${data}`,
  );
  for (const index of view.indexes) await sql.unsafe(index);
  const [{ me } = { me: '' }] = await sql.unsafe<{ me: string }[]>(
    'SELECT current_user AS me',
  );
  if (view.owner !== me)
    await sql.unsafe(
      `ALTER ${view.kind} ${view.relation} OWNER TO ${quote(view.owner)}`,
    );
  // COMMENT cannot bind values; Postgres quotes the text itself.
  const comments = await sql.unsafe<{ statement: string }[]>(
    `SELECT format('COMMENT ON ${view.kind} %s IS %L', $1::text, $2::text) AS statement WHERE $2::text IS NOT NULL
     UNION ALL
     SELECT format('COMMENT ON COLUMN %s.%I IS %L', $1::text, c->>'name', c->>'description')
     FROM json_array_elements($3::text::json) AS c`,
    [view.relation, view.description, JSON.stringify(view.columns)],
  );
  for (const { statement } of comments) await sql.unsafe(statement);
}
