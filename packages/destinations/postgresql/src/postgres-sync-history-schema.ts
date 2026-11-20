import { syncHistoryRelations } from '@eltjs/elt';

import { derivedStatusTable } from './postgres-derived-status.ts';
import { marts, warehouse } from './postgres-schemas.ts';
import type { PostgresView } from './postgres-views.ts';

// The tables of the history in _warehouse.
export const attempts = `${warehouse}.sync_attempts`;
export const coverage = `${warehouse}.extraction_coverage`;
export const checks = `${warehouse}.stream_checks`;
const unversioned = `${warehouse}._elt_unversioned`;

// When connector's stream last matched its upstream: the start of its last
// successful pass, or a later check that found it unchanged, each no later
// than when the source said the upstream itself was last current. NULL if it
// never succeeded. LEAST and GREATEST skip NULLs.
const currentAsOf = (connector: string, stream: string) => `(
        SELECT CASE WHEN success.id IS NULL THEN NULL ELSE GREATEST(LEAST(success.started_at, success.upstream_current_as_of), k.checked_at) END
        FROM (SELECT 1) one
        LEFT JOIN LATERAL (
          SELECT s.id, s.started_at, sc.upstream_current_as_of FROM ${coverage} sc
          JOIN ${attempts} s ON s.id = sc.attempt_id
          WHERE s.connector = ${connector} AND sc.stream = ${stream} AND sc.status = 'succeeded'
          ORDER BY s.completed_at DESC, s.id DESC LIMIT 1
        ) success ON true
        LEFT JOIN ${checks} k ON k.connector = ${connector} AND k.stream = ${stream}
      )`;

const queries: Readonly<Record<keyof typeof syncHistoryRelations, string>> = {
  sync_attempts: `SELECT id AS attempt_id, connector, source, started_at, completed_at, status, error, failure_type FROM ${attempts}`,
  extraction_coverage: `SELECT c.attempt_id, a.connector, a.source, a.started_at, a.completed_at,
      c.stream, c.target_table,
      EXISTS (SELECT FROM pg_class t
        WHERE t.relnamespace = '${marts}'::regnamespace AND t.relname = c.target_table AND t.relkind = 'v') AS target_exists,
      c.sync_mode, c.destination_sync_mode, c.description, c.selection,
      c.status, c.written_count, c.deleted_count, c.failures
      FROM ${coverage} c JOIN ${attempts} a ON a.id = c.attempt_id`,
  sync_status: `SELECT DISTINCT ON (a.connector) a.connector,
      a.id AS latest_attempt_id, a.started_at, a.completed_at, a.status, a.error, a.failure_type,
      success.id AS last_successful_attempt_id, success.completed_at AS last_successful_sync_at,
      (SELECT CASE WHEN count(*) = count(current_as_of) THEN min(current_as_of) END
        FROM (SELECT ${currentAsOf('a.connector', 'd.stream')} AS current_as_of
          FROM (SELECT DISTINCT dc.stream FROM ${coverage} dc
            JOIN ${attempts} da ON da.id = dc.attempt_id
            WHERE da.connector = a.connector) d) streams) AS current_as_of
      FROM ${attempts} a
      LEFT JOIN LATERAL (
        SELECT id, completed_at FROM ${attempts}
        WHERE connector = a.connector AND status = 'succeeded'
        ORDER BY completed_at DESC, id DESC LIMIT 1
      ) success ON true
      ORDER BY a.connector, a.id DESC`,
  stream_status: `SELECT DISTINCT ON (a.connector, c.stream) a.connector, c.stream,
      c.target_table,
      a.id AS latest_attempt_id, a.started_at, a.completed_at, c.status,
      success.id AS last_successful_attempt_id, success.completed_at AS last_successful_sync_at,
      ${currentAsOf('a.connector', 'c.stream')} AS current_as_of
      FROM ${coverage} c
      JOIN ${attempts} a ON a.id = c.attempt_id
      LEFT JOIN LATERAL (
        SELECT s.id, s.completed_at FROM ${coverage} sc
        JOIN ${attempts} s ON s.id = sc.attempt_id
        WHERE s.connector = a.connector AND sc.stream = c.stream AND sc.status = 'succeeded'
        ORDER BY s.completed_at DESC, s.id DESC LIMIT 1
      ) success ON true
      ORDER BY a.connector, c.stream, a.id DESC`,
  derived_status: `SELECT dataset, kind, state, as_of, refreshed_at, refreshing_since, error, inputs, computed, empty, failed, pending FROM ${warehouse}.derived_status ORDER BY dataset`,
};

// How readers see the sync history: what each pass declared and loaded.
// The sync history keeps no row versions, so a reading as of a position
// fails each of its views: the scalar subquery is a one-time filter, which
// Postgres evaluates before it reads a row.
export const syncHistoryViews: readonly PostgresView[] = Object.values(
  syncHistoryRelations,
).map((relation) => ({
  ...relation,
  query: `SELECT * FROM (${queries[relation.name]}) AS "history" WHERE (SELECT ${unversioned}())`,
}));

export const syncHistoryTables = [
  `CREATE SCHEMA IF NOT EXISTS ${warehouse}`,
  `CREATE TABLE IF NOT EXISTS ${attempts} (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    connector text NOT NULL CHECK (btrim(connector) <> ''), source text NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled')),
    error text,
    failure_type text CHECK (failure_type IN ('config', 'system')),
    CHECK ((status = 'running') = (completed_at IS NULL)),
    CHECK ((status IN ('partial', 'failed')) = (failure_type IS NOT NULL))
  )`,
  `CREATE OR REPLACE FUNCTION ${unversioned}() RETURNS boolean LANGUAGE plpgsql STABLE AS $$
  BEGIN
    IF coalesce(current_setting('elt.position', true), '') <> '' THEN
      RAISE EXCEPTION 'The sync history cannot be read as of a position: it keeps no row versions';
    END IF;
    RETURN true;
  END $$`,
  `CREATE INDEX IF NOT EXISTS sync_attempts_connector ON ${attempts} (connector, id DESC)`,
  `CREATE TABLE IF NOT EXISTS ${coverage} (
    attempt_id bigint NOT NULL REFERENCES ${attempts}(id),
    stream text NOT NULL, target_table text NOT NULL,
    sync_mode text NOT NULL, destination_sync_mode text NOT NULL,
    description text NOT NULL CHECK (btrim(description) <> ''), selection jsonb NOT NULL,
    status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed', 'cancelled')),
    written_count bigint CHECK (written_count >= 0), deleted_count bigint CHECK (deleted_count >= 0),
    failures jsonb NOT NULL DEFAULT '[]', upstream_current_as_of timestamptz,
    PRIMARY KEY (attempt_id, stream)
  )`,
  // Each stream's latest check by a watch that found it unchanged.
  `CREATE TABLE IF NOT EXISTS ${checks} (
    connector text NOT NULL, stream text NOT NULL, checked_at timestamptz NOT NULL,
    PRIMARY KEY (connector, stream)
  )`,
  derivedStatusTable,
] as const;
