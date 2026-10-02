export type QueueJobState =
  'created' | 'retry' | 'active' | 'completed' | 'cancelled' | 'failed';

export type QueuePolicy =
  | 'standard'
  | 'short'
  | 'singleton'
  | 'stately'
  | 'exclusive'
  | 'key_strict_fifo'
  | (string & {});

export interface QueueOptions {
  expireInSeconds?: number;
  retentionSeconds?: number;
  deleteAfterSeconds?: number;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  heartbeatSeconds?: number;
}

export interface QueueCreateOptions extends QueueOptions {
  policy?: QueuePolicy;
  partition?: boolean;
  deadLetter?: string;
  warningQueueSize?: number;
}

export type QueueUpdateOptions = QueueOptions &
  Pick<QueueCreateOptions, 'deadLetter' | 'warningQueueSize'>;

export interface QueueGroupOptions {
  id: string;
  tier?: string;
}

export interface QueueGroupConcurrencyConfig {
  default: number;
  tiers?: Record<string, number>;
}

export interface QueueSendOptions extends QueueOptions {
  id?: string;
  priority?: number;
  startAfter?: number | string | Date;
  singletonKey?: string;
  singletonSeconds?: number;
  singletonNextSlot?: boolean;
  keepUntil?: number | string | Date;
  group?: QueueGroupOptions;
  deadLetter?: string;
}

export interface QueueScheduleOptions extends QueueSendOptions {
  tz?: string;
  key?: string;
}

export interface QueueFindJobsOptions {
  id?: string;
  key?: string;
  data?: object;
  queued?: boolean;
}

export interface QueueWorkOptions {
  pollingIntervalSeconds?: number;
  includeMetadata?: boolean;
  priority?: boolean;
  orderByCreatedOn?: boolean;
  batchSize?: number;
  ignoreStartAfter?: boolean;
  minPriority?: number;
  maxPriority?: number;
  localConcurrency?: number;
  localGroupConcurrency?: number | QueueGroupConcurrencyConfig;
  groupConcurrency?: number | QueueGroupConcurrencyConfig;
  heartbeatRefreshSeconds?: number;
}

export interface QueueStopOptions {
  close?: boolean;
  graceful?: boolean;
  timeout?: number;
}

export interface QueueJob<TData = object> {
  id: string;
  name: string;
  data: TData;
  expireInSeconds: number;
  heartbeatSeconds: number | null;
  signal: AbortSignal;
  groupId?: string | null;
  groupTier?: string | null;
}

export interface QueueJobWithMetadata<TData = object> extends QueueJob<TData> {
  priority?: number;
  state: QueueJobState;
  retryLimit?: number;
  retryCount?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  retryDelayMax?: number;
  startAfter?: Date;
  startedOn?: Date;
  singletonKey?: string | null;
  singletonOn?: Date | null;
  deleteAfterSeconds?: number;
  createdOn?: Date;
  completedOn?: Date | null;
  keepUntil?: Date;
  policy?: QueuePolicy;
  heartbeatOn?: Date | null;
  deadLetter?: string;
  output?: object;
}

export type QueueFailure = object | null | undefined;

export interface BackgroundQueue {
  // pg-boss's `error` event (PgBossEventMap, node_modules/pg-boss/dist/types.d.ts):
  // failures in work no caller awaits — worker polls, cron, the pool. With no
  // listener, EventEmitter throws on emit.
  on(event: 'error', listener: (error: Error) => void): this;
  start(): Promise<unknown>;
  stop(options?: QueueStopOptions): Promise<unknown>;
  createQueue(name: string, options?: QueueCreateOptions): Promise<void>;
  updateQueue(name: string, options?: QueueUpdateOptions): Promise<void>;
  deleteQueue(name: string): Promise<void>;
  send<TData extends object>(
    name: string,
    data?: TData | null,
    options?: QueueSendOptions,
  ): Promise<string | null>;
  work<TData>(
    name: string,
    options: QueueWorkOptions,
    handler: (jobs: QueueJob<TData>[]) => Promise<unknown>,
  ): Promise<unknown>;
  findJobs<TData extends object>(
    name: string,
    options?: QueueFindJobsOptions,
  ): Promise<QueueJobWithMetadata<TData>[]>;
  cancel(name: string, id: string | string[]): Promise<unknown>;
  fail(
    name: string,
    id: string | string[],
    data?: QueueFailure,
  ): Promise<unknown>;
  schedule<TData extends object>(
    name: string,
    cron: string,
    data?: TData | null,
    options?: QueueScheduleOptions,
  ): Promise<void>;
  unschedule(name: string, key?: string): Promise<void>;
}

export type JobQueue = BackgroundQueue;
