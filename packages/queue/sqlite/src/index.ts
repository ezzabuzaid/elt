import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

import { CronExpressionParser } from 'cron-parser';

import type {
  BackgroundQueue,
  QueueCreateOptions,
  QueueFailure,
  QueueFindJobsOptions,
  QueueJob,
  QueueJobState,
  QueueJobWithMetadata,
  QueueScheduleOptions,
  QueueSendOptions,
  QueueStopOptions,
  QueueUpdateOptions,
  QueueWorkOptions,
} from '@workspace/queue-abstract';

import {
  SQLITE_QUEUE_SCHEMA,
  assertSqliteSupportedQueuePolicy,
} from './schema.ts';

// A slot missed by more than this is abandoned, not replayed: the cursor moves
// to the next occurrence and nothing is sent. Matches pg-boss, which fires a
// cron only while its previous occurrence is under 60s old, so both backends
// answer "the process was down through a slot" the same way.
const SCHEDULE_GRACE_SECONDS = 60;

export {
  SQLITE_BACKGROUND_QUEUE_TABLES,
  SQLITE_QUEUE_SCHEMA,
  SQLITE_SUPPORTED_QUEUE_POLICIES,
  assertSqliteSupportedQueuePolicy,
  isSqliteSupportedQueuePolicy,
  type SqliteSupportedQueuePolicy,
} from './schema.ts';

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// pg-boss keeps the original error and adds the queue and worker id
// (node_modules/pg-boss/dist/manager.js:313). Wrapping it in a `cause` would
// drop the original stack: the log serializer keeps only a cause's name,
// message and diagnostic keys (packages/logging/src/index.ts:125).
function toWorkerError(value: unknown, worker: SqliteWorker) {
  return Object.assign(toError(value), {
    queue: worker.name,
    worker: worker.id,
  });
}

export interface SqliteJobQueueOptions {
  path?: string;
  database?: DatabaseSync;
  pollingIntervalMs?: number;
  schedule?: boolean;
  schedulePollingIntervalMs?: number;
  idGenerator?: () => string;
  now?: () => Date;
}

type SqliteWorker = {
  id: string;
  name: string;
  options: QueueWorkOptions;
  handler: (jobs: QueueJob<any>[]) => Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
  activeRuns: Set<Promise<void>>;
  stopped: boolean;
};

type QueueRow = {
  name: string;
  policy: 'standard' | 'exclusive';
  retry_limit: number;
  retry_delay_seconds: number;
  retry_backoff: number;
  retry_delay_max_seconds: number | null;
  expire_seconds: number;
  retention_seconds: number;
  deletion_seconds: number;
  heartbeat_seconds: number | null;
  dead_letter: string | null;
  warning_queue_size: number;
};

type JobRow = {
  id: string;
  queue_name: string;
  data: string;
  state: QueueJobState;
  policy: 'standard' | 'exclusive';
  priority: number;
  retry_limit: number;
  retry_count: number;
  retry_delay_seconds: number;
  retry_backoff: number;
  retry_delay_max_seconds: number | null;
  start_after: string;
  singleton_key: string | null;
  singleton_on: string | null;
  expire_seconds: number;
  retention_seconds: number;
  deletion_seconds: number;
  heartbeat_seconds: number | null;
  heartbeat_on: string | null;
  lease_expires_on: string | null;
  created_on: string;
  started_on: string | null;
  completed_on: string | null;
  keep_until: string | null;
  cancelled_on: string | null;
  failed_on: string | null;
  output: string | null;
  error: string | null;
  dead_letter: string | null;
  group_id: string | null;
  group_tier: string | null;
};

type ScheduleRow = {
  queue_name: string;
  key: string;
  cron: string;
  timezone: string;
  data: string;
  options: string;
  next_run_on: string;
};

type SqliteRow = Record<string, unknown>;

function isSqliteRow(value: unknown): value is SqliteRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireSqliteRow(value: unknown, label: string): SqliteRow {
  if (!isSqliteRow(value)) {
    throw new Error(`Expected SQLite row for ${label}`);
  }

  return value;
}

function readString(row: SqliteRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Expected string SQLite column: ${column}`);
  }

  return value;
}

function readNullableString(row: SqliteRow, column: string): string | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected nullable string SQLite column: ${column}`);
  }

  return value;
}

function readNumber(row: SqliteRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new Error(`Expected number SQLite column: ${column}`);
  }

  return value;
}

function readNullableNumber(row: SqliteRow, column: string): number | null {
  const value = row[column];
  if (value === null) {
    return null;
  }
  if (typeof value !== 'number') {
    throw new Error(`Expected nullable number SQLite column: ${column}`);
  }

  return value;
}

function readQueuePolicy(row: SqliteRow): QueueRow['policy'] {
  const policy = readString(row, 'policy');
  if (policy === 'standard' || policy === 'exclusive') {
    return policy;
  }

  throw new Error(`Unsupported SQLite queue policy: ${policy}`);
}

function readJobState(row: SqliteRow): QueueJobState {
  const state = readString(row, 'state');
  if (
    state === 'created' ||
    state === 'retry' ||
    state === 'active' ||
    state === 'completed' ||
    state === 'cancelled' ||
    state === 'failed'
  ) {
    return state;
  }

  throw new Error(`Unsupported SQLite job state: ${state}`);
}

function mapQueueRow(value: unknown): QueueRow {
  const row = requireSqliteRow(value, 'queue');
  return {
    name: readString(row, 'name'),
    policy: readQueuePolicy(row),
    retry_limit: readNumber(row, 'retry_limit'),
    retry_delay_seconds: readNumber(row, 'retry_delay_seconds'),
    retry_backoff: readNumber(row, 'retry_backoff'),
    retry_delay_max_seconds: readNullableNumber(row, 'retry_delay_max_seconds'),
    expire_seconds: readNumber(row, 'expire_seconds'),
    retention_seconds: readNumber(row, 'retention_seconds'),
    deletion_seconds: readNumber(row, 'deletion_seconds'),
    heartbeat_seconds: readNullableNumber(row, 'heartbeat_seconds'),
    dead_letter: readNullableString(row, 'dead_letter'),
    warning_queue_size: readNumber(row, 'warning_queue_size'),
  };
}

function mapJobRow(value: unknown): JobRow {
  const row = requireSqliteRow(value, 'job');
  return {
    id: readString(row, 'id'),
    queue_name: readString(row, 'queue_name'),
    data: readString(row, 'data'),
    state: readJobState(row),
    policy: readQueuePolicy(row),
    priority: readNumber(row, 'priority'),
    retry_limit: readNumber(row, 'retry_limit'),
    retry_count: readNumber(row, 'retry_count'),
    retry_delay_seconds: readNumber(row, 'retry_delay_seconds'),
    retry_backoff: readNumber(row, 'retry_backoff'),
    retry_delay_max_seconds: readNullableNumber(row, 'retry_delay_max_seconds'),
    start_after: readString(row, 'start_after'),
    singleton_key: readNullableString(row, 'singleton_key'),
    singleton_on: readNullableString(row, 'singleton_on'),
    expire_seconds: readNumber(row, 'expire_seconds'),
    retention_seconds: readNumber(row, 'retention_seconds'),
    deletion_seconds: readNumber(row, 'deletion_seconds'),
    heartbeat_seconds: readNullableNumber(row, 'heartbeat_seconds'),
    heartbeat_on: readNullableString(row, 'heartbeat_on'),
    lease_expires_on: readNullableString(row, 'lease_expires_on'),
    created_on: readString(row, 'created_on'),
    started_on: readNullableString(row, 'started_on'),
    completed_on: readNullableString(row, 'completed_on'),
    keep_until: readNullableString(row, 'keep_until'),
    cancelled_on: readNullableString(row, 'cancelled_on'),
    failed_on: readNullableString(row, 'failed_on'),
    output: readNullableString(row, 'output'),
    error: readNullableString(row, 'error'),
    dead_letter: readNullableString(row, 'dead_letter'),
    group_id: readNullableString(row, 'group_id'),
    group_tier: readNullableString(row, 'group_tier'),
  };
}

function mapScheduleRow(value: unknown): ScheduleRow {
  const row = requireSqliteRow(value, 'schedule');
  return {
    queue_name: readString(row, 'queue_name'),
    key: readString(row, 'key'),
    cron: readString(row, 'cron'),
    timezone: readString(row, 'timezone'),
    data: readString(row, 'data'),
    options: readString(row, 'options'),
    next_run_on: readString(row, 'next_run_on'),
  };
}

function normalizeOptions(
  options?: string | SqliteJobQueueOptions,
): Required<Pick<SqliteJobQueueOptions, 'pollingIntervalMs'>> &
  Omit<SqliteJobQueueOptions, 'pollingIntervalMs'> {
  if (typeof options === 'string' || options === undefined) {
    return {
      path: options ?? ':memory:',
      pollingIntervalMs: 200,
      schedule: true,
      schedulePollingIntervalMs: 1000,
    };
  }

  return {
    ...options,
    path: options.path ?? ':memory:',
    pollingIntervalMs: options.pollingIntervalMs ?? 200,
    schedule: options.schedule ?? true,
    schedulePollingIntervalMs: options.schedulePollingIntervalMs ?? 1000,
  };
}

function assertQueueName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('queue name is required');
  }
}

function asIso(value: Date): string {
  return value.toISOString();
}

function parseDate(value: string | null | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

function parseNullableDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function toSqlBool(value: boolean | undefined): number | undefined {
  return value === undefined ? undefined : value ? 1 : 0;
}

function mapFailureData(data: QueueFailure): string | null {
  if (data === null || typeof data === 'undefined') {
    return null;
  }

  return JSON.stringify(data);
}

function jsonContains(actual: unknown, expected: unknown): boolean {
  if (expected === actual) return true;
  if (
    typeof expected !== 'object' ||
    expected === null ||
    typeof actual !== 'object' ||
    actual === null
  ) {
    return false;
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }

  if (!isSqliteRow(expected) || !isSqliteRow(actual)) {
    return false;
  }

  return Object.entries(expected).every(([key, value]) =>
    jsonContains(actual[key], value),
  );
}

function isConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('SQLITE_CONSTRAINT') ||
      error.message.includes('constraint failed') ||
      error.message.includes('UNIQUE constraint failed'))
  );
}

function buildCommandResponse(ids: string[], affected: number) {
  return {
    jobs: ids,
    requested: ids.length,
    affected,
  };
}

function resolveLocalConcurrency(options: QueueWorkOptions): number {
  const localConcurrency = options.localConcurrency ?? 1;
  if (!Number.isFinite(localConcurrency) || localConcurrency < 1) {
    return 1;
  }

  return Math.floor(localConcurrency);
}

export class SqliteJobQueue
  extends EventEmitter<{ error: [error: Error] }>
  implements BackgroundQueue
{
  private readonly db: DatabaseSync;
  private readonly closeDatabase: boolean;
  private readonly pollingIntervalMs: number;
  private readonly scheduleEnabled: boolean;
  private readonly schedulePollingIntervalMs: number;
  private readonly idGenerator: () => string;
  private readonly now: () => Date;
  private readonly workers = new Map<string, SqliteWorker>();
  private readonly activeJobControllers = new Map<string, AbortController>();
  private scheduleTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(options?: string | SqliteJobQueueOptions) {
    super();
    const normalized = normalizeOptions(options);
    this.db =
      normalized.database ?? new DatabaseSync(normalized.path ?? ':memory:');
    this.closeDatabase = normalized.database === undefined;
    this.pollingIntervalMs = normalized.pollingIntervalMs;
    this.scheduleEnabled = normalized.schedule ?? true;
    this.schedulePollingIntervalMs =
      normalized.schedulePollingIntervalMs ?? 1000;
    this.idGenerator = normalized.idGenerator ?? randomUUID;
    this.now = normalized.now ?? (() => new Date());
  }

  async start(): Promise<this> {
    this.applySchema();
    this.started = true;
    this.startScheduleMonitor();
    return this;
  }

  async stop(options?: QueueStopOptions): Promise<void> {
    const workers = Array.from(this.workers.values());
    for (const worker of workers) {
      worker.stopped = true;
      if (worker.timer) {
        clearTimeout(worker.timer);
      }
    }

    if (options?.graceful) {
      await Promise.allSettled(
        workers.flatMap((worker) => Array.from(worker.activeRuns)),
      );
    }

    this.workers.clear();
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = undefined;
    }
    this.started = false;

    if (options?.close && this.closeDatabase) {
      this.db.close();
    }
  }

  async createQueue(
    name: string,
    options: QueueCreateOptions = {},
  ): Promise<void> {
    this.ensureReady();
    assertQueueName(name);
    assertSqliteSupportedQueuePolicy(options.policy);
    if (options.partition) {
      throw new Error('SQLite queue partitioning is not supported');
    }

    const policy = options.policy ?? 'standard';
    this.db
      .prepare(
        `INSERT OR IGNORE INTO background_queues (
          name,
          policy,
          retry_limit,
          retry_delay_seconds,
          retry_backoff,
          retry_delay_max_seconds,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          heartbeat_seconds,
          dead_letter,
          warning_queue_size
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        policy,
        options.retryLimit ?? 2,
        options.retryDelay ?? 0,
        toSqlBool(options.retryBackoff) ?? 0,
        options.retryDelayMax ?? null,
        options.expireInSeconds ?? 900,
        options.retentionSeconds ?? 1_209_600,
        options.deleteAfterSeconds ?? 604_800,
        options.heartbeatSeconds ?? null,
        options.deadLetter ?? null,
        options.warningQueueSize ?? 0,
      );
  }

  async updateQueue(
    name: string,
    options: QueueUpdateOptions = {},
  ): Promise<void> {
    this.ensureReady();
    assertQueueName(name);
    const entries = this.mapQueueUpdateOptions(options);

    if (entries.length === 0) {
      throw new Error('no properties found to update');
    }

    const updatedOn = asIso(this.now());
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
    const values = entries.map(([, value]) => value);

    this.db
      .prepare(
        `UPDATE background_queues
        SET ${assignments}, updated_on = ?
        WHERE name = ?`,
      )
      .run(...values, updatedOn, name);
  }

  async deleteQueue(name: string): Promise<void> {
    this.ensureReady();
    assertQueueName(name);
    this.db.prepare('DELETE FROM background_queues WHERE name = ?').run(name);
  }

  async send<TData extends object>(
    name: string,
    data?: TData | null,
    options: QueueSendOptions = {},
  ): Promise<string | null> {
    this.ensureReady();
    assertQueueName(name);
    const queue = this.getQueueOrThrow(name);
    const now = this.now();
    const startAfter = this.resolveStartAfter(options.startAfter, now);
    const retentionSeconds =
      options.retentionSeconds ?? queue.retention_seconds;
    const keepUntil =
      options.keepUntil === undefined
        ? addSeconds(startAfter, retentionSeconds)
        : this.resolveStartAfter(options.keepUntil, now);
    const id = options.id ?? this.idGenerator();

    try {
      this.db
        .prepare(
          `INSERT INTO background_jobs (
            id,
            queue_name,
            data,
            policy,
            priority,
            retry_limit,
            retry_delay_seconds,
            retry_backoff,
            retry_delay_max_seconds,
            start_after,
            singleton_key,
            singleton_on,
            expire_seconds,
            retention_seconds,
            deletion_seconds,
            heartbeat_seconds,
            created_on,
            keep_until,
            dead_letter,
            group_id,
            group_tier
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          JSON.stringify(data ?? null),
          queue.policy,
          options.priority ?? 0,
          options.retryLimit ?? queue.retry_limit,
          options.retryDelay ?? queue.retry_delay_seconds,
          toSqlBool(options.retryBackoff) ?? queue.retry_backoff,
          options.retryDelayMax ?? queue.retry_delay_max_seconds,
          asIso(startAfter),
          options.singletonKey ?? null,
          this.resolveSingletonOn(options, now),
          options.expireInSeconds ?? queue.expire_seconds,
          retentionSeconds,
          options.deleteAfterSeconds ?? queue.deletion_seconds,
          options.heartbeatSeconds ?? queue.heartbeat_seconds,
          asIso(now),
          asIso(keepUntil),
          options.deadLetter ?? queue.dead_letter,
          options.group?.id ?? null,
          options.group?.tier ?? null,
        );
    } catch (error) {
      if (isConstraintError(error)) {
        return null;
      }

      throw error;
    }

    this.notifyWorkers(name);
    return id;
  }

  async work<TData>(
    name: string,
    options: QueueWorkOptions,
    handler: (jobs: QueueJob<TData>[]) => Promise<unknown>,
  ): Promise<string> {
    this.ensureReady();
    assertQueueName(name);
    this.getQueueOrThrow(name);

    const id = this.idGenerator();
    const worker: SqliteWorker = {
      id,
      name,
      options,
      handler,
      activeRuns: new Set(),
      stopped: false,
    };

    this.workers.set(id, worker);
    this.scheduleWorker(worker, 0);
    return id;
  }

  async findJobs<TData extends object>(
    name: string,
    options: QueueFindJobsOptions = {},
  ): Promise<QueueJobWithMetadata<TData>[]> {
    this.ensureReady();
    assertQueueName(name);
    this.getQueueOrThrow(name);

    const where = ['queue_name = ?'];
    const values: SQLInputValue[] = [name];

    if (options.id !== undefined) {
      where.push('id = ?');
      values.push(options.id);
    }

    if (options.key !== undefined) {
      where.push('singleton_key = ?');
      values.push(options.key);
    }

    if (options.queued) {
      where.push("state IN ('created', 'retry')");
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM background_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY created_on, id`,
      )
      .all(...values)
      .map(mapJobRow);

    const filteredRows =
      options.data === undefined
        ? rows
        : rows.filter((row) =>
            jsonContains(JSON.parse(row.data), options.data),
          );

    return filteredRows.map((row) => this.mapJob<TData>(row));
  }

  async cancel(name: string, id: string | string[]) {
    this.ensureReady();
    assertQueueName(name);
    this.getQueueOrThrow(name);
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) {
      throw new Error('cancel() requires an id');
    }

    const now = asIso(this.now());
    const statement = this.db.prepare(
      `UPDATE background_jobs
      SET state = 'cancelled', completed_on = ?, cancelled_on = ?
      WHERE queue_name = ?
        AND id = ?
        AND state IN ('created', 'retry', 'active')`,
    );

    let affected = 0;
    this.transaction(() => {
      for (const jobId of ids) {
        const changes = Number(statement.run(now, now, name, jobId).changes);
        affected += changes;
        if (changes > 0) {
          this.abortActiveJob(jobId);
        }
      }
    });

    return buildCommandResponse(ids, affected);
  }

  async fail(name: string, id: string | string[], data?: QueueFailure) {
    this.ensureReady();
    assertQueueName(name);
    this.getQueueOrThrow(name);
    const ids = Array.isArray(id) ? id : [id];
    if (ids.length === 0) {
      throw new Error('fail() requires an id');
    }

    const output = mapFailureData(data);
    let affected = 0;
    this.transaction(() => {
      for (const jobId of ids) {
        affected += this.failOne(name, jobId, output);
      }
    });

    this.notifyWorkers(name);
    return buildCommandResponse(ids, affected);
  }

  async schedule<TData extends object>(
    name: string,
    cron: string,
    data?: TData | null,
    options: QueueScheduleOptions = {},
  ): Promise<void> {
    this.ensureReady();
    assertQueueName(name);
    this.getQueueOrThrow(name);
    const key = options.key ?? '';
    const scheduleOptions = { ...options };
    delete scheduleOptions.key;
    delete scheduleOptions.tz;
    const nextRunOn = this.nextCronRun(cron, options.tz ?? 'UTC', this.now());

    this.db
      .prepare(
        `INSERT INTO background_schedules (
          queue_name,
          key,
          cron,
          timezone,
          data,
          options,
          next_run_on,
          updated_on
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(queue_name, key) DO UPDATE SET
          cron = excluded.cron,
          timezone = excluded.timezone,
          data = excluded.data,
          options = excluded.options,
          next_run_on = excluded.next_run_on,
          updated_on = excluded.updated_on`,
      )
      .run(
        name,
        key,
        cron,
        options.tz ?? 'UTC',
        JSON.stringify(data ?? null),
        JSON.stringify(scheduleOptions),
        asIso(nextRunOn),
        asIso(this.now()),
      );
  }

  async unschedule(name: string, key = ''): Promise<void> {
    this.ensureReady();
    assertQueueName(name);
    this.db
      .prepare(
        `DELETE FROM background_schedules
        WHERE queue_name = ? AND key = ?`,
      )
      .run(name, key);
  }

  async runDueSchedules(): Promise<void> {
    this.ensureReady();
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT *
        FROM background_schedules
        WHERE next_run_on <= ?
        ORDER BY next_run_on, queue_name, key`,
      )
      .all(asIso(now))
      .map(mapScheduleRow);

    for (const row of rows) {
      const staleSeconds =
        (now.getTime() - new Date(row.next_run_on).getTime()) / 1000;
      if (staleSeconds < SCHEDULE_GRACE_SECONDS) {
        const data: object | null = JSON.parse(row.data);
        const options: QueueSendOptions = JSON.parse(row.options);
        await this.send(row.queue_name, data, options);
      }
      const nextRunOn = this.nextCronRun(row.cron, row.timezone, now);
      this.db
        .prepare(
          `UPDATE background_schedules
          SET next_run_on = ?, updated_on = ?
          WHERE queue_name = ? AND key = ?`,
        )
        .run(asIso(nextRunOn), asIso(now), row.queue_name, row.key);
    }
  }

  private applySchema(): void {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    for (const statement of SQLITE_QUEUE_SCHEMA) {
      this.db.exec(statement);
    }
  }

  private ensureReady(): void {
    if (!this.started) {
      this.applySchema();
      this.started = true;
      this.startScheduleMonitor();
    }
  }

  private startScheduleMonitor(): void {
    if (!this.scheduleEnabled || this.scheduleTimer) {
      return;
    }

    this.scheduleTimer = setInterval(() => {
      void this.runDueSchedules().catch((error: unknown) => {
        this.emit('error', toError(error));
      });
    }, this.schedulePollingIntervalMs);
  }

  private mapQueueUpdateOptions(options: QueueUpdateOptions) {
    const entries: Array<[string, SQLInputValue]> = [];

    this.pushOption(entries, 'retry_limit', options.retryLimit);
    this.pushOption(entries, 'retry_delay_seconds', options.retryDelay);
    this.pushOption(entries, 'retry_backoff', toSqlBool(options.retryBackoff));
    this.pushOption(entries, 'retry_delay_max_seconds', options.retryDelayMax);
    this.pushOption(entries, 'expire_seconds', options.expireInSeconds);
    this.pushOption(entries, 'retention_seconds', options.retentionSeconds);
    this.pushOption(entries, 'deletion_seconds', options.deleteAfterSeconds);
    this.pushOption(entries, 'heartbeat_seconds', options.heartbeatSeconds);
    this.pushOption(entries, 'dead_letter', options.deadLetter);
    this.pushOption(entries, 'warning_queue_size', options.warningQueueSize);

    return entries;
  }

  private pushOption(
    entries: Array<[string, SQLInputValue]>,
    column: string,
    value: SQLInputValue | undefined,
  ): void {
    if (value !== undefined) {
      entries.push([column, value]);
    }
  }

  private getQueueOrThrow(name: string): QueueRow {
    const queue = this.db
      .prepare('SELECT * FROM background_queues WHERE name = ?')
      .get(name);

    if (!queue) {
      throw new Error(`Queue ${name} does not exist`);
    }

    return mapQueueRow(queue);
  }

  private resolveStartAfter(
    value: QueueSendOptions['startAfter'] | QueueSendOptions['keepUntil'],
    now: Date,
  ): Date {
    if (value instanceof Date) {
      return value;
    }

    if (typeof value === 'number') {
      return addSeconds(now, value);
    }

    if (typeof value === 'string') {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }

      const seconds = Number.parseFloat(value);
      if (!Number.isNaN(seconds)) {
        return addSeconds(now, seconds);
      }
    }

    return now;
  }

  private resolveSingletonOn(
    options: QueueSendOptions,
    now: Date,
  ): string | null {
    if (options.singletonSeconds === undefined) {
      return null;
    }

    const seconds = options.singletonSeconds;
    const slot = Math.floor(now.getTime() / 1000 / seconds) * seconds;
    return asIso(new Date(slot * 1000));
  }

  private nextCronRun(cron: string, timezone: string, currentDate: Date): Date {
    return CronExpressionParser.parse(cron, {
      currentDate,
      tz: timezone,
    })
      .next()
      .toDate();
  }

  private scheduleWorker(worker: SqliteWorker, delay: number): void {
    if (worker.stopped || worker.timer) {
      return;
    }

    worker.timer = setTimeout(() => {
      worker.timer = undefined;
      this.fillWorkerSlots(worker);
    }, delay);
  }

  private rescheduleWorker(worker: SqliteWorker, delay: number): void {
    if (worker.timer) {
      clearTimeout(worker.timer);
      worker.timer = undefined;
    }

    this.scheduleWorker(worker, delay);
  }

  private notifyWorkers(name: string): void {
    for (const worker of this.workers.values()) {
      if (
        worker.name !== name ||
        worker.stopped ||
        !this.hasWorkerCapacity(worker)
      ) {
        continue;
      }

      this.rescheduleWorker(worker, 0);
    }
  }

  private hasWorkerCapacity(worker: SqliteWorker): boolean {
    return worker.activeRuns.size < resolveLocalConcurrency(worker.options);
  }

  private fillWorkerSlots(worker: SqliteWorker): void {
    if (worker.stopped) {
      return;
    }

    try {
      while (this.hasWorkerCapacity(worker)) {
        const started = this.startWorkerRun(worker);
        if (!started) {
          break;
        }
      }
    } catch (error) {
      this.emit('error', toWorkerError(error, worker));
    }

    if (this.hasWorkerCapacity(worker)) {
      this.scheduleWorker(worker, this.pollingIntervalMs);
    }
  }

  private startWorkerRun(worker: SqliteWorker): boolean {
    const jobs = this.claimJobs(worker.name, worker.options);
    if (jobs.length === 0) {
      return false;
    }

    const activeRun = this.handleClaimedJobs(worker, jobs)
      .catch((error: unknown) => {
        this.emit('error', toWorkerError(error, worker));
      })
      .finally(() => {
        worker.activeRuns.delete(activeRun);
        this.rescheduleWorker(worker, 0);
      });
    worker.activeRuns.add(activeRun);
    return true;
  }

  private async handleClaimedJobs<TData>(
    worker: SqliteWorker,
    jobs: QueueJob<TData>[],
  ): Promise<void> {
    try {
      await worker.handler(jobs);
      this.completeJobs(
        worker.name,
        jobs.map((job) => job.id),
      );
    } catch (error) {
      const failure =
        error instanceof Error ? { message: error.message } : { value: error };
      await this.fail(
        worker.name,
        jobs.map((job) => job.id),
        failure,
      );
    }
  }

  private claimJobs<TData>(
    name: string,
    options: QueueWorkOptions,
  ): QueueJob<TData>[] {
    const batchSize = options.batchSize ?? 1;
    const now = asIso(this.now());
    const where = [
      'queue_name = ?',
      "state IN ('created', 'retry')",
      options.ignoreStartAfter ? undefined : 'start_after <= ?',
      options.minPriority === undefined ? undefined : 'priority >= ?',
      options.maxPriority === undefined ? undefined : 'priority <= ?',
    ].filter(Boolean);
    const values: SQLInputValue[] = [name];

    if (!options.ignoreStartAfter) {
      values.push(now);
    }
    if (options.minPriority !== undefined) {
      values.push(options.minPriority);
    }
    if (options.maxPriority !== undefined) {
      values.push(options.maxPriority);
    }

    const order = [
      options.priority === false ? undefined : 'priority DESC',
      options.orderByCreatedOn === false ? undefined : 'created_on',
      'id',
    ].filter(Boolean);
    const rows = this.db
      .prepare(
        `SELECT * FROM background_jobs
        WHERE ${where.join(' AND ')}
        ORDER BY ${order.join(', ')}
        LIMIT ?`,
      )
      .all(...values, batchSize)
      .map(mapJobRow);

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    this.transaction(() => {
      const statement = this.db.prepare(
        `UPDATE background_jobs
        SET state = 'active',
          started_on = ?,
          heartbeat_on = ?,
          lease_expires_on = ?,
          retry_count = CASE
            WHEN started_on IS NOT NULL THEN retry_count + 1
            ELSE retry_count
          END
        WHERE queue_name = ? AND id = ? AND state IN ('created', 'retry')`,
      );
      for (const row of rows) {
        const leaseExpiresOn =
          row.heartbeat_seconds === null
            ? null
            : asIso(addSeconds(this.now(), row.heartbeat_seconds));
        statement.run(now, now, leaseExpiresOn, name, row.id);
      }
    });

    const claimedRows = this.db
      .prepare(
        `SELECT * FROM background_jobs
        WHERE queue_name = ? AND id IN (${ids.map(() => '?').join(', ')})
        ORDER BY created_on, id`,
      )
      .all(name, ...ids)
      .map(mapJobRow);

    return claimedRows.map((row) => this.mapClaimedJob<TData>(row));
  }

  private completeJobs(name: string, ids: string[]): void {
    const now = asIso(this.now());
    const statement = this.db.prepare(
      `UPDATE background_jobs
      SET state = 'completed', completed_on = ?
      WHERE queue_name = ? AND id = ? AND state = 'active'`,
    );

    this.transaction(() => {
      for (const id of ids) {
        statement.run(now, name, id);
        this.activeJobControllers.delete(id);
      }
    });
  }

  private failOne(name: string, id: string, output: string | null): number {
    const row = this.db
      .prepare(
        `SELECT * FROM background_jobs
        WHERE queue_name = ? AND id = ? AND state IN ('created', 'retry', 'active')`,
      )
      .get(name, id);

    if (!row) {
      return 0;
    }
    const job = mapJobRow(row);

    const now = this.now();
    const retry = job.retry_count < job.retry_limit;
    const startAfter = retry
      ? this.nextRetryStartAfter(job, now)
      : new Date(job.start_after);

    const result = this.db
      .prepare(
        `UPDATE background_jobs
        SET state = ?,
          start_after = ?,
          completed_on = ?,
          failed_on = ?,
          output = ?,
          heartbeat_on = NULL,
          lease_expires_on = NULL
        WHERE queue_name = ? AND id = ?`,
      )
      .run(
        retry ? 'retry' : 'failed',
        asIso(startAfter),
        retry ? null : asIso(now),
        retry ? null : asIso(now),
        output,
        name,
        id,
      );

    if (Number(result.changes) > 0 && job.state === 'active') {
      this.abortActiveJob(id);
    }

    return Number(result.changes);
  }

  private nextRetryStartAfter(row: JobRow, now: Date): Date {
    const retryDelay = row.retry_delay_seconds;
    if (!row.retry_backoff) {
      return addSeconds(now, retryDelay);
    }

    const retryAttempt = Math.min(16, row.retry_count + 1);
    const delay = retryDelay * 2 ** retryAttempt;
    const max = row.retry_delay_max_seconds ?? delay;
    return addSeconds(now, Math.min(delay, max));
  }

  private mapJob<TData>(
    row: JobRow,
    signal = new AbortController().signal,
  ): QueueJobWithMetadata<TData> {
    const data: TData = JSON.parse(row.data);

    return {
      id: row.id,
      name: row.queue_name,
      data,
      expireInSeconds: row.expire_seconds,
      heartbeatSeconds: row.heartbeat_seconds,
      signal,
      groupId: row.group_id,
      groupTier: row.group_tier,
      priority: row.priority,
      state: row.state,
      retryLimit: row.retry_limit,
      retryCount: row.retry_count,
      retryDelay: row.retry_delay_seconds,
      retryBackoff: Boolean(row.retry_backoff),
      retryDelayMax: row.retry_delay_max_seconds ?? undefined,
      startAfter: parseDate(row.start_after),
      startedOn: parseDate(row.started_on),
      singletonKey: row.singleton_key,
      singletonOn: parseNullableDate(row.singleton_on),
      deleteAfterSeconds: row.deletion_seconds,
      createdOn: parseDate(row.created_on),
      completedOn: parseNullableDate(row.completed_on),
      keepUntil: parseDate(row.keep_until),
      policy: row.policy,
      heartbeatOn: parseNullableDate(row.heartbeat_on),
      deadLetter: row.dead_letter ?? undefined,
      output: row.output === null ? undefined : JSON.parse(row.output),
    };
  }

  private mapClaimedJob<TData>(row: JobRow): QueueJob<TData> {
    const controller = new AbortController();
    this.activeJobControllers.set(row.id, controller);
    return this.mapJob<TData>(row, controller.signal);
  }

  private abortActiveJob(id: string): void {
    const controller = this.activeJobControllers.get(id);
    if (!controller) {
      return;
    }

    controller.abort();
    this.activeJobControllers.delete(id);
  }

  private transaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function createSqliteJobQueue(
  options?: string | SqliteJobQueueOptions,
): SqliteJobQueue {
  return new SqliteJobQueue(options);
}
