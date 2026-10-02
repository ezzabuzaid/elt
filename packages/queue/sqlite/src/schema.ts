import type { QueuePolicy } from '@workspace/queue-abstract';

export const SQLITE_BACKGROUND_QUEUE_TABLES = [
  'background_queues',
  'background_jobs',
  'background_schedules',
] as const;

export const SQLITE_SUPPORTED_QUEUE_POLICIES = [
  'standard',
  'exclusive',
] as const satisfies readonly QueuePolicy[];

export type SqliteSupportedQueuePolicy =
  (typeof SQLITE_SUPPORTED_QUEUE_POLICIES)[number];

export function isSqliteSupportedQueuePolicy(
  policy: QueuePolicy | undefined,
): policy is SqliteSupportedQueuePolicy | undefined {
  return (
    policy === undefined ||
    SQLITE_SUPPORTED_QUEUE_POLICIES.some((supported) => supported === policy)
  );
}

export function assertSqliteSupportedQueuePolicy(
  policy: QueuePolicy | undefined,
): asserts policy is SqliteSupportedQueuePolicy | undefined {
  if (isSqliteSupportedQueuePolicy(policy)) {
    return;
  }

  throw new Error(`SQLite queue policy is not supported: ${policy}`);
}

export const SQLITE_QUEUE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS background_queues (
    name TEXT PRIMARY KEY,
    policy TEXT NOT NULL DEFAULT 'standard' CHECK (policy IN ('standard', 'exclusive')),
    retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit >= 0),
    retry_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_delay_seconds >= 0),
    retry_backoff INTEGER NOT NULL DEFAULT 0 CHECK (retry_backoff IN (0, 1)),
    retry_delay_max_seconds INTEGER CHECK (retry_delay_max_seconds IS NULL OR retry_delay_max_seconds >= 0),
    expire_seconds INTEGER NOT NULL DEFAULT 900 CHECK (expire_seconds >= 1),
    retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds >= 1),
    deletion_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (deletion_seconds >= 0),
    heartbeat_seconds INTEGER CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds >= 10),
    dead_letter TEXT,
    warning_queue_size INTEGER NOT NULL DEFAULT 0 CHECK (warning_queue_size >= 0),
    created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS background_jobs (
    id TEXT PRIMARY KEY,
    queue_name TEXT NOT NULL REFERENCES background_queues(name) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'created' CHECK (state IN ('created', 'retry', 'active', 'completed', 'cancelled', 'failed')),
    policy TEXT NOT NULL DEFAULT 'standard' CHECK (policy IN ('standard', 'exclusive')),
    priority INTEGER NOT NULL DEFAULT 0,
    retry_limit INTEGER NOT NULL DEFAULT 2 CHECK (retry_limit >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    retry_delay_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_delay_seconds >= 0),
    retry_backoff INTEGER NOT NULL DEFAULT 0 CHECK (retry_backoff IN (0, 1)),
    retry_delay_max_seconds INTEGER CHECK (retry_delay_max_seconds IS NULL OR retry_delay_max_seconds >= 0),
    start_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    singleton_key TEXT,
    singleton_on TEXT,
    expire_seconds INTEGER NOT NULL DEFAULT 900 CHECK (expire_seconds >= 1),
    retention_seconds INTEGER NOT NULL DEFAULT 1209600 CHECK (retention_seconds >= 1),
    deletion_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (deletion_seconds >= 0),
    heartbeat_seconds INTEGER CHECK (heartbeat_seconds IS NULL OR heartbeat_seconds >= 10),
    heartbeat_on TEXT,
    lease_expires_on TEXT,
    created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_on TEXT,
    completed_on TEXT,
    keep_until TEXT,
    cancelled_on TEXT,
    failed_on TEXT,
    output TEXT,
    error TEXT,
    dead_letter TEXT,
    group_id TEXT,
    group_tier TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS background_schedules (
    queue_name TEXT NOT NULL REFERENCES background_queues(name) ON DELETE CASCADE,
    key TEXT NOT NULL,
    cron TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    data TEXT NOT NULL DEFAULT '{}',
    options TEXT NOT NULL DEFAULT '{}',
    next_run_on TEXT NOT NULL,
    created_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_on TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (queue_name, key)
  )`,
  `CREATE INDEX IF NOT EXISTS background_jobs_fetch_i
    ON background_jobs (queue_name, state, priority DESC, start_after, created_on)`,
  `CREATE INDEX IF NOT EXISTS background_jobs_singleton_i
    ON background_jobs (queue_name, singleton_key)
    WHERE singleton_key IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS background_jobs_lease_i
    ON background_jobs (lease_expires_on)
    WHERE state = 'active' AND lease_expires_on IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS background_jobs_exclusive_i
    ON background_jobs (queue_name, COALESCE(singleton_key, ''))
    WHERE state IN ('created', 'retry', 'active') AND policy = 'exclusive'`,
] as const;
