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
    'running: no completion recorded; succeeded: all selected copies completed, including empty or unchanged reads; partial: failures with some successful copies or committed writes/deletes; failed: failures without that progress; cancelled: the run was stopped on request, and error says why; what it committed before stays. No health of a watch is implied.',
  error:
    'Pipeline error message, or NULL after success or before completion. Per-copy failures and partitions are in extraction_coverage.',
  failure_type:
    "Whose the failure is to fix, as the source classified it: config when at least one failure needs the user to change what they set up or granted, such as macOS access to the app's store; system for every other failure, which the user cannot fix by granting or configuring. NULL after success, before completion, or when cancelled.",
};

// How readers see the sync history: what each pass declared and loaded.
export const syncHistoryRelations = {
  sync_attempts: {
    name: 'sync_attempts',
    description:
      'One row per pass of a connection. A run passes every stream the connection selected; a watch pass reads only the streams whose change signals changed, so an attempt vouches only for its own extraction_coverage rows. History is retained, including failures and unfinished attempts. A successful pass may write zero rows. A connection that stopped, a failed change signal or a failed upkeep records a failed attempt without outcomes. Setup/authentication before the pipeline is constructed is not observed. This records extraction/load outcomes, not subsequent mart publication.',
    columns: attempt,
  },
  extraction_coverage: {
    name: 'extraction_coverage',
    description:
      'One row per selected stream per attempt, declared before extraction even when there are no records. Description and selection describe the requested export scope, not observed record dates or proof of upstream completeness. Only succeeded confirms that this copy completed that declared pass; partial/failed/running never establish complete coverage. Earlier successful declarations remain available. target_table names the reader view of the stream, which catalog describes.',
    columns: {
      attempt_id: attempt.attempt_id,
      connector: attempt.connector,
      source: attempt.source,
      started_at: attempt.started_at,
      completed_at:
        'Time the whole attempt was recorded as complete; NULL while unfinished. The copy may have finished earlier. Not record modification time or loaded_at.',
      stream: 'Source stream name, unique within one attempt.',
      target_table:
        'Name of the reader view that readers query for the rows of this stream.',
      target_exists:
        'Whether that reader view exists now, independent of this historical attempt. Existence does not prove successful extraction or current contents.',
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
        'Array of {partition, error, failure_type, stacktrace} from pass outcomes. A null partition denotes a whole-stream or non-partition-specific failure; failure_type is config or system, as in sync_attempts. error is the message; stacktrace is the error with its stack and every cause it chains, such as the code of a refused connection behind "fetch failed". Empty array means none recorded; check status before assuming success.',
    },
  },
  sync_status: {
    name: 'sync_status',
    description:
      'One row per connector with its latest started attempt, independently its most recently completed successful pass, and how current its data is. A watch pass covers only the streams that changed; see stream_status for each stream. A later failed, partial or unfinished pass does not erase prior success. Join extraction_coverage using the appropriate attempt ID: requested scope can change. NULL success means none recorded. Judge freshness by current_as_of: last_successful_sync_at measures sync completion, not service liveness or source completeness.',
    columns: {
      connector: attempt.connector,
      latest_attempt_id:
        'Most recently started attempt for this connector; join sync_attempts or extraction_coverage by attempt_id.',
      started_at: attempt.started_at,
      completed_at: attempt.completed_at,
      status: attempt.status,
      error: attempt.error,
      failure_type: attempt.failure_type,
      last_successful_attempt_id:
        'Most recently completed all-copies-successful attempt; NULL if none. Its coverage may differ from the latest attempt.',
      last_successful_sync_at:
        'Completion time of that successful pass, advanced even if no rows changed. NULL if no successful pass was recorded. Never inferred from loaded_at or record modification dates.',
      current_as_of:
        "The oldest current_as_of among the connector's streams in stream_status: everything it loaded matched its upstream at least as of this time. NULL until every stream has loaded once. An old value means its data is that old: no pass or watch has refreshed it since, a change failed to load, or the app that writes its upstream has not written it since, as WhatsApp while it is closed.",
    },
  },
  stream_status: {
    name: 'stream_status',
    description:
      'One row per connector and stream: the latest attempt that declared the stream, independently the last attempt in which its copy succeeded, and how current the stream is. A watch pass reads only the streams its source reported changed, so a connector can succeed in sync_status while one of its streams last failed, and an unchanged stream keeps an old last_successful_sync_at while its watch keeps it current, up to when its source says its upstream was last current; judge a stream here, by current_as_of. NULL success means that stream never completed.',
    columns: {
      connector: attempt.connector,
      stream: 'Source stream name.',
      target_table:
        'Name of the reader view of this stream in the latest declaration.',
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
      current_as_of:
        'When the stream last matched its upstream: when its last successful pass began reading, or a later check by a watch that found the stream unchanged since, whichever is later, and never later than when its source says the upstream itself was last current, as an app writes its store only while it runs. A watch records its checks about once a minute. NULL if the stream never succeeded. A stream whose latest change failed to load keeps the time before that change, so its age is how stale it is; compare it with the current time to judge freshness.',
    },
  },
  derived_status: {
    name: 'derived_status',
    description:
      'One row per derived dataset, a view or a computed dataset, and what its refreshes left: whether it waits for its inputs, refreshes, is current or failed, as of when, and for a computed dataset how many of its inputs it computed, found empty, failed on or has still to compute. sync_status can say succeeded while a computed dataset still computes, or failed on each of its inputs; judge derived data here. A dataset is caught up when its state is current, its pending is 0, and its as_of is at or after the start of the last pass of the connections it reads, in sync_status. No row means that no refresh of the dataset ran yet.',
    columns: {
      dataset:
        'Name of the view or computed dataset that readers query, as the pipeline declares it.',
      kind: 'view: Postgres or SQLite computes it from its SQL on each read. computed: a rule computes one output row for each input, which readers query with its status.',
      state:
        'waiting: a relation that it reads is not made yet, so it holds no data; refreshing: a refresh runs since refreshing_since; current: the last refresh ended with no failure of the dataset; failed: the last refresh failed, and error says why. A refresh that a stopped process left stays refreshing until the next refresh.',
      as_of:
        'When the last refresh that ended with no failure began to read its inputs: the derived data shows what the copies had committed then. NULL if no refresh ended so.',
      refreshed_at:
        'When the last refresh that ended with no failure ended. NULL if no refresh ended so.',
      refreshing_since:
        'When the refresh that runs began; NULL while none runs.',
      error:
        'Why the last refresh failed, such as SQL that the database refused, or NULL. A rule that fails on one input is not a failure of the dataset: that output row has status failed, and failed counts it.',
      inputs:
        'How many inputs the computed dataset read in its last refresh; NULL for a view.',
      computed:
        'How many output rows had status computed when the refresh that runs began, or when the last refresh ended; NULL for a view. Count the rows of the dataset for the rows that landed since.',
      empty:
        'How many output rows had status empty when the refresh that runs began, or when the last refresh ended; NULL for a view.',
      failed:
        'How many output rows had status failed when the refresh that runs began, or when the last refresh ended; the next refresh after a pass tries each of them again. NULL for a view.',
      pending:
        'How many inputs the computed dataset has still to compute in the refresh that runs, or that a stopped refresh left; each commit of the refresh lowers it, and it is 0 once a refresh ends. NULL for a view.',
    },
  },
} as const satisfies Record<string, ReaderRelation>;
