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
COMMENT ON SCHEMA marts IS 'Read-only warehouse contract. Discover relations and meanings through catalog, which the loading application publishes; check sync_status and extraction_coverage. Collection and refresh belong to connectors, not consumers.';
ALTER DEFAULT PRIVILEGES FOR ROLE warehouse IN SCHEMA marts
  GRANT SELECT ON TABLES TO agent_reader;

