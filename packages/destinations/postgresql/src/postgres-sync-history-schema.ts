import { syncHistoryRelations } from '@workspace/elt';

import type { PostgresView } from './postgres-views.ts';

const queries: Readonly<Record<keyof typeof syncHistoryRelations, string>> = {
  sync_attempts:
    'SELECT id AS attempt_id, connector, source, started_at, completed_at, status, error FROM _warehouse.sync_attempts',
  extraction_coverage: `SELECT c.attempt_id, a.connector, a.source, a.started_at, a.completed_at,
      c.stream, c.target_schema, c.target_table,
      EXISTS (SELECT FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = c.target_schema AND t.relname = c.target_table AND t.relkind = 'r') AS target_exists,
      c.sync_mode, c.destination_sync_mode, c.description, c.selection,
      c.status, c.written_count, c.deleted_count, c.failures
      FROM _warehouse.extraction_coverage c JOIN _warehouse.sync_attempts a ON a.id = c.attempt_id`,
  sync_status: `SELECT DISTINCT ON (a.connector) a.connector,
      a.id AS latest_attempt_id, a.started_at, a.completed_at, a.status, a.error,
      success.id AS last_successful_attempt_id, success.completed_at AS last_successful_sync_at
      FROM _warehouse.sync_attempts a
      LEFT JOIN LATERAL (
        SELECT id, completed_at FROM _warehouse.sync_attempts
        WHERE connector = a.connector AND status = 'succeeded'
        ORDER BY completed_at DESC, id DESC LIMIT 1
      ) success ON true
      ORDER BY a.connector, a.id DESC`,
  stream_status: `SELECT DISTINCT ON (a.connector, c.stream) a.connector, c.stream,
      c.target_schema, c.target_table,
      a.id AS latest_attempt_id, a.started_at, a.completed_at, c.status,
      success.id AS last_successful_attempt_id, success.completed_at AS last_successful_sync_at
      FROM _warehouse.extraction_coverage c
      JOIN _warehouse.sync_attempts a ON a.id = c.attempt_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.completed_at FROM _warehouse.extraction_coverage sc
        JOIN _warehouse.sync_attempts s ON s.id = sc.attempt_id
        WHERE s.connector = a.connector AND sc.stream = c.stream AND sc.status = 'succeeded'
        ORDER BY s.completed_at DESC, s.id DESC LIMIT 1
      ) success ON true
      ORDER BY a.connector, c.stream, a.id DESC`,
};

// How readers see the sync history: what each pass declared and loaded.
export const syncHistoryViews: readonly PostgresView[] = Object.values(
  syncHistoryRelations,
).map((relation) => ({ ...relation, query: queries[relation.name] }));

export const syncHistoryTables = [
  'CREATE SCHEMA IF NOT EXISTS _warehouse',
  `CREATE TABLE IF NOT EXISTS _warehouse.sync_attempts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    connector text NOT NULL CHECK (btrim(connector) <> ''), source text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    error text,
    CHECK ((status = 'running') = (completed_at IS NULL))
  )`,
  'CREATE INDEX IF NOT EXISTS sync_attempts_connector ON _warehouse.sync_attempts (connector, id DESC)',
  `CREATE TABLE IF NOT EXISTS _warehouse.extraction_coverage (
    attempt_id bigint NOT NULL REFERENCES _warehouse.sync_attempts(id),
    stream text NOT NULL, target_schema text NOT NULL, target_table text NOT NULL,
    sync_mode text NOT NULL, destination_sync_mode text NOT NULL,
    description text NOT NULL CHECK (btrim(description) <> ''), selection jsonb NOT NULL,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    written_count bigint CHECK (written_count >= 0), deleted_count bigint CHECK (deleted_count >= 0),
    failures jsonb NOT NULL DEFAULT '[]', PRIMARY KEY (attempt_id, stream)
  )`,
] as const;
