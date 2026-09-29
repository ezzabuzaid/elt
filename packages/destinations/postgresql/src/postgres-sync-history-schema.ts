import type { PostgresView } from './postgres-views.ts';

const attempt = {
  attempt_id:
    'Pass identifier. Join to extraction_coverage.attempt_id for the exact declarations and copy outcomes of this pass.',
  connector:
    'Connection name declared by the application. Each attempt is one pass: one read of the streams the connection selected.',
  source: 'Source identity, not credentials or a record identifier.',
  started_at:
    'Database time when the attempt and its declared coverage were recorded, before the pass read anything. Not a source record modification or row load time.',
  completed_at:
    'Database time when the pass outcomes were recorded. NULL means no completion was recorded; this is not evidence that a process is alive.',
  status:
    'running: no completion recorded; succeeded: all selected copies completed, including empty or unchanged reads; partial: failures with some successful copies or committed writes/deletes; failed: failures without that progress. No watcher health is implied.',
  error:
    'Pipeline error message, or NULL after success or before completion. Per-copy failures and partitions are in extraction_coverage.',
};

// How readers see the sync history: what each pass declared and loaded.
export const syncHistoryViews: readonly PostgresView[] = [
  {
    name: 'sync_attempts',
    query:
      'SELECT id AS attempt_id, connector, source, started_at, completed_at, status, error FROM _warehouse.sync_attempts',
    description:
      'One row per pass of a connection. A run passes every stream the connection selected; a watch pass reads only the streams its source reported changed, so an attempt vouches only for its own extraction_coverage rows. History is retained, including failures and unfinished attempts. A successful pass may write zero rows. A connection whose watcher stopped records a failed attempt without outcomes. Setup/authentication before the pipeline is constructed is not observed. This records extraction/load outcomes, not subsequent mart publication.',
    columns: attempt,
  },
  {
    name: 'extraction_coverage',
    query: `SELECT c.attempt_id, a.connector, a.source, a.started_at, a.completed_at,
      c.stream, c.target_schema, c.target_table,
      EXISTS (SELECT FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = c.target_schema AND t.relname = c.target_table AND t.relkind = 'r') AS target_exists,
      c.sync_mode, c.destination_sync_mode, c.description, c.selection,
      c.status, c.written_count, c.deleted_count, c.failures
      FROM _warehouse.extraction_coverage c JOIN _warehouse.sync_attempts a ON a.id = c.attempt_id`,
    description:
      'One row per selected stream per attempt, declared before extraction even when there are no records. Description and selection describe the requested export scope, not observed record dates or proof of upstream completeness. Only succeeded confirms that this copy completed that declared pass; partial/failed/running never establish complete coverage. Earlier successful declarations remain available. Raw target names identify storage, not reader grants; discover readable content in catalog.',
    columns: {
      attempt_id: attempt.attempt_id,
      connector: attempt.connector,
      source: attempt.source,
      started_at: attempt.started_at,
      completed_at:
        'Time the whole attempt was recorded as complete; NULL while unfinished. The copy may have finished earlier. Not record modification time or loaded_at.',
      stream: 'Source stream name, unique within one attempt.',
      target_schema:
        'Raw destination schema; this metadata does not grant access to it.',
      target_table: 'Raw destination table name within target_schema.',
      target_exists:
        'Whether the raw relation exists now, independent of this historical attempt. Existence does not prove successful extraction, current contents, or reader access.',
      sync_mode:
        'Requested source mode: incremental or full_refresh. Incremental copies can resume saved state; the selection describes their configured scope, not every request made on this pass.',
      destination_sync_mode:
        'Requested load mode, such as append_dedup. Partial passes can leave previously committed changes in the destination.',
      description:
        'Connector-owned explanation of the scope, date boundaries, selection keys and source limitations for this stream.',
      selection:
        'Structured configured selection, interpreted using description. Not computed from rows. Empty object means no additional configured selection, not unlimited upstream history.',
      status:
        'running: no outcome recorded; succeeded: copy completed with no failures, even with zero changes; partial: failures after committed writes/deletes; failed: failures without committed row changes, or an error without outcomes. Consult failures for affected partitions.',
      written_count:
        'Accepted record operations committed by this copy during this pass, including deduplication no-ops. Not changed-row or total-record counts. Zero is valid after success. NULL means no counts were reported.',
      deleted_count:
        'Accepted deletion operations committed by this copy during this pass, including already-absent keys. Not a count of rows actually removed. NULL means no counts were reported.',
      failures:
        'Array of {partition, error} from pass outcomes. A null partition denotes a whole-stream or non-partition-specific failure. Empty array means none recorded; check status before assuming success.',
    },
  },
  {
    name: 'sync_status',
    query: `SELECT DISTINCT ON (a.connector) a.connector,
      a.id AS latest_attempt_id, a.started_at, a.completed_at, a.status, a.error,
      success.id AS last_successful_attempt_id, success.completed_at AS last_successful_sync_at
      FROM _warehouse.sync_attempts a
      LEFT JOIN LATERAL (
        SELECT id, completed_at FROM _warehouse.sync_attempts
        WHERE connector = a.connector AND status = 'succeeded'
        ORDER BY completed_at DESC, id DESC LIMIT 1
      ) success ON true
      ORDER BY a.connector, a.id DESC`,
    description:
      'One row per connector with its latest started attempt and independently its most recently completed successful pass. A watch pass covers only the streams that changed; see stream_status for each stream. A later failed, partial or unfinished pass does not erase prior success. Join extraction_coverage using the appropriate attempt ID: requested scope can change. NULL success means none recorded. These timestamps measure sync completion, not service liveness or source completeness.',
    columns: {
      connector: attempt.connector,
      latest_attempt_id:
        'Most recently started attempt for this connector; join sync_attempts or extraction_coverage by attempt_id.',
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      status: attempt.status,
      error: attempt.error,
      last_successful_attempt_id:
        'Most recently completed all-copies-successful attempt; NULL if none. Its coverage may differ from the latest attempt.',
      last_successful_sync_at:
        'Completion time of that successful pass, advanced even if no rows changed. NULL if no successful pass was recorded. Never inferred from loaded_at or record modification dates.',
    },
  },
  {
    name: 'stream_status',
    query: `SELECT DISTINCT ON (a.connector, c.stream) a.connector, c.stream,
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
    description:
      'One row per connector and stream: the latest attempt that declared the stream, and independently the last attempt in which its copy succeeded. A watch pass reads only the streams its source reported changed, so a connector can succeed in sync_status while one of its streams last failed; judge a stream here. NULL success means that stream never completed.',
    columns: {
      connector: attempt.connector,
      stream: 'Source stream name.',
      target_schema:
        'Raw destination schema of the latest declaration; this metadata does not grant access to it.',
      target_table: 'Raw destination table name within target_schema.',
      latest_attempt_id:
        'Most recently started attempt that declared this stream; join extraction_coverage by attempt_id and stream.',
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      status:
        "This stream's copy status in the latest attempt: running, succeeded, partial or failed. Other streams of the same attempt may differ.",
      last_successful_attempt_id:
        "Most recent completed attempt in which this stream's copy succeeded; NULL if none.",
      last_successful_sync_at:
        'Completion time of that attempt, advanced even if no rows changed. NULL if this stream never succeeded. Never inferred from loaded_at or record modification dates.',
    },
  },
];

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
