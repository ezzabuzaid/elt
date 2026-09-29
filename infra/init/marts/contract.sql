-- What agent_reader may see in the current database: the marts schema only.
-- The warehouse role loads raw schemas and publishes marts; every table and
-- view it creates in marts is readable, so no loader grants anything itself.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO agent_reader', current_database());
END
$$;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS marts AUTHORIZATION warehouse;
REVOKE ALL ON SCHEMA marts FROM PUBLIC;
GRANT USAGE ON SCHEMA marts TO agent_reader;
COMMENT ON SCHEMA marts IS 'Read-only warehouse contract. Discover relations and meanings through catalog; check sync_status and extraction_coverage. Collection and refresh belong to connectors, not consumers.';
ALTER DEFAULT PRIVILEGES FOR ROLE warehouse IN SCHEMA marts
  GRANT SELECT ON TABLES TO agent_reader;

SET ROLE warehouse;
CREATE OR REPLACE VIEW marts.catalog AS
  SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
    c.relname::text AS name, NULL::text AS data_type,
    obj_description(c.oid, 'pg_class') AS description
  FROM pg_class c
  WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind IN ('v', 'r')
  UNION ALL
  SELECT 'column', c.relname || '.' || a.attname,
    format_type(a.atttypid, a.atttypmod), col_description(c.oid, a.attnum)
  FROM pg_class c
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind IN ('v', 'r')
  ORDER BY 2;
COMMENT ON VIEW marts.catalog IS 'One row per readable marts view, table and column, explaining meaning and use. Discover sync_status and extraction_coverage before judging freshness or completeness. Raw schemas are private.';
COMMENT ON COLUMN marts.catalog.kind IS 'view, table or column.';
COMMENT ON COLUMN marts.catalog.name IS 'Relation name in marts, or relation.column.';
COMMENT ON COLUMN marts.catalog.data_type IS 'Column type; NULL for relations.';
COMMENT ON COLUMN marts.catalog.description IS 'Meaning, limitations and usage guidance; does not authorize refresh or other writes.';
RESET ROLE;
