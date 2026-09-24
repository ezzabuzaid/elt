import type postgres from 'postgres';

export type Sql = postgres.Sql;

export function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * What every connector's marts share, installed as the loading role. The
 * reader connects to the database and reads marts; privileges, not session
 * settings, are the barrier, since a session can change its own settings.
 * Views run with their owner's rights, so the reader needs no grant on the
 * raw schemas elt loads.
 */
export async function installWarehouse(
  sql: Sql,
  { reader }: { reader: string },
): Promise<void> {
  const role = quote(reader);
  const [{ database }] = await sql<
    [{ database: string }]
  >`SELECT current_database() AS database`;
  await sql.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtextextended('mac-elt:marts', 0))`;
    for (const statement of [
      `REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC`,
      `GRANT CONNECT ON DATABASE ${quote(database)} TO ${role}`,
      'REVOKE ALL ON SCHEMA public FROM PUBLIC',
      'CREATE SCHEMA IF NOT EXISTS marts',
      'REVOKE ALL ON SCHEMA marts FROM PUBLIC',
      `GRANT USAGE ON SCHEMA marts TO ${role}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA marts GRANT SELECT ON TABLES TO ${role}`,
      `COMMENT ON SCHEMA marts IS 'Everything an agent may read. Start with SELECT * FROM catalog; check freshness before answering about recent days.'`,
      // Agents reach marts through a server that allows only built-in
      // functions, so every calculation lives inside a view or at load time.
      // Helpers are prefixed with _ and left out of the catalog.
      `CREATE OR REPLACE FUNCTION marts._url_path(url text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
        RETURN CASE WHEN url ~* '^[a-z][a-z0-9+.-]*://' THEN coalesce(nullif(substring(url FROM '^[A-Za-z][A-Za-z0-9+.-]*://[^/?#]*([^?#]*)'), ''), '/') END`,
      `CREATE TABLE IF NOT EXISTS marts.freshness (relation text PRIMARY KEY, latest_date date, latest_settled_date date, loaded_at timestamptz)`,
      `COMMENT ON TABLE marts.freshness IS 'Per view: the latest day it covers, the latest day Google no longer restates, and when it was last loaded. Refreshed after every load.'`,
      `COMMENT ON COLUMN marts.freshness.relation IS 'The view it describes.'`,
      `COMMENT ON COLUMN marts.freshness.latest_date IS 'The latest day in the view; NULL for views without a date.'`,
      `COMMENT ON COLUMN marts.freshness.latest_settled_date IS 'The latest day Google will no longer restate; NULL for views without settled days.'`,
      `COMMENT ON COLUMN marts.freshness.loaded_at IS 'When the view last received rows.'`,
      `GRANT SELECT ON marts.freshness TO ${role}`,
      `CREATE OR REPLACE FUNCTION marts._refresh_freshness() RETURNS void LANGUAGE plpgsql AS $$
        DECLARE
          candidate record;
        BEGIN
          DELETE FROM marts.freshness;
          FOR candidate IN
            SELECT c.relname,
              bool_or(a.attname = 'date') AS has_date,
              bool_or(a.attname = 'settled') AS has_settled
            FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind = 'v'
            GROUP BY c.relname
            HAVING bool_or(a.attname = 'loaded_at')
          LOOP
            EXECUTE format(
              'INSERT INTO marts.freshness SELECT %L, %s, %s, max(loaded_at) FROM marts.%I',
              candidate.relname,
              CASE WHEN candidate.has_date THEN 'max(date)' ELSE 'NULL::date' END,
              CASE WHEN candidate.has_date AND candidate.has_settled THEN 'max(date) FILTER (WHERE settled)' ELSE 'NULL::date' END,
              candidate.relname);
          END LOOP;
        END $$`,
      `CREATE OR REPLACE VIEW marts.catalog AS
        SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind, c.relname::text AS name, NULL::text AS data_type, obj_description(c.oid, 'pg_class') AS description
        FROM pg_class c WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind IN ('v', 'r')
        UNION ALL
        SELECT 'column', c.relname || '.' || a.attname, format_type(a.atttypid, a.atttypmod), col_description(c.oid, a.attnum)
        FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind IN ('v', 'r')
        ORDER BY 2`,
      `COMMENT ON VIEW marts.catalog IS 'One row per view, table and column an agent may read, with what it means and how to aggregate it.'`,
      `COMMENT ON COLUMN marts.catalog.kind IS 'view, table or column.'`,
      `COMMENT ON COLUMN marts.catalog.name IS 'Relation name, or relation.column.'`,
      `COMMENT ON COLUMN marts.catalog.data_type IS 'Column type; NULL for views and tables.'`,
      `COMMENT ON COLUMN marts.catalog.description IS 'What it means and how to use it correctly.'`,
    ])
      await transaction.unsafe(statement);
  });
}
