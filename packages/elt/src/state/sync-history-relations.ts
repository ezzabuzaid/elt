import type { ReaderRelation } from '../core/reader-relation.ts';

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
    'running: no completion recorded; succeeded: all selected copies completed, including empty or unchanged reads; partial: failures with some successful copies or committed writes/deletes; failed: failures without that progress; cancelled: the run was stopped on request, and error says why; what it committed before stays. No watcher health is implied.',
  error:
    'Pipeline error message, or NULL after success or before completion. Per-copy failures and partitions are in extraction_coverage.',
};

// How readers see the sync history: what each pass declared and loaded.
export const syncHistoryRelations = {
  sync_attempts: {
    name: 'sync_attempts',
    description:
      'One row per pass of a connection. A run passes every stream the connection selected; a watch pass reads only the streams its source reported changed, so an attempt vouches only for its own extraction_coverage rows. History is retained, including failures and unfinished attempts. A successful pass may write zero rows. A connection whose watcher stopped records a failed attempt without outcomes. Setup/authentication before the pipeline is constructed is not observed. This records extraction/load outcomes, not subsequent mart publication.',
    columns: attempt,
  },
  extraction_coverage: {
    name: 'extraction_coverage',
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
        'Schema of the raw destination table (main in SQLite); this metadata does not grant access to it.',
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
        'running: no outcome recorded; succeeded: copy completed with no failures, even with zero changes; partial: failures after committed writes/deletes; failed: failures without committed row changes, or an error without outcomes; cancelled: the run was stopped on request before this copy ended, keeping what it committed. Consult failures for affected partitions.',
      written_count:
        'Accepted record operations committed by this copy during this pass, including deduplication no-ops. Not changed-row or total-record counts. Zero is valid after success. NULL means no counts were reported.',
      deleted_count:
        'Accepted deletion operations committed by this copy during this pass, including already-absent keys. Not a count of rows actually removed. NULL means no counts were reported.',
      failures:
        'Array of {partition, error} from pass outcomes. A null partition denotes a whole-stream or non-partition-specific failure. Empty array means none recorded; check status before assuming success.',
    },
  },
  sync_status: {
    name: 'sync_status',
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
  stream_status: {
    name: 'stream_status',
    description:
      'One row per connector and stream: the latest attempt that declared the stream, and independently the last attempt in which its copy succeeded. A watch pass reads only the streams its source reported changed, so a connector can succeed in sync_status while one of its streams last failed; judge a stream here. NULL success means that stream never completed.',
    columns: {
      connector: attempt.connector,
      stream: 'Source stream name.',
      target_schema:
        'Schema of the raw destination table in the latest declaration (main in SQLite); this metadata does not grant access to it.',
      target_table: 'Raw destination table name within target_schema.',
      latest_attempt_id:
        'Most recently started attempt that declared this stream; join extraction_coverage by attempt_id and stream.',
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      status:
        "This stream's copy status in the latest attempt: running, succeeded, partial, failed or cancelled. Other streams of the same attempt may differ.",
      last_successful_attempt_id:
        "Most recent completed attempt in which this stream's copy succeeded; NULL if none.",
      last_successful_sync_at:
        'Completion time of that attempt, advanced even if no rows changed. NULL if this stream never succeeded. Never inferred from loaded_at or record modification dates.',
    },
  },
} as const satisfies Record<string, ReaderRelation>;
