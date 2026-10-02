import { PgBoss } from 'pg-boss';
import type {
  ConstructorOptions,
  FindJobsOptions,
  ScheduleOptions,
  SendOptions,
  StopOptions,
  WorkOptions,
} from 'pg-boss';

import type {
  BackgroundQueue,
  QueueCreateOptions,
  QueueFailure,
  QueueFindJobsOptions,
  QueueJob,
  QueueJobWithMetadata,
  QueueScheduleOptions,
  QueueSendOptions,
  QueueStopOptions,
  QueueUpdateOptions,
  QueueWorkOptions,
} from '@workspace/queue-abstract';

export class PgBossJobQueue implements BackgroundQueue {
  private readonly boss: PgBoss;

  constructor(boss: PgBoss) {
    this.boss = boss;
  }

  on(event: 'error', listener: (error: Error) => void): this {
    this.boss.on(event, listener);
    return this;
  }

  start(): Promise<unknown> {
    return this.boss.start();
  }

  stop(options?: QueueStopOptions): Promise<unknown> {
    return this.boss.stop(options);
  }

  createQueue(name: string, options?: QueueCreateOptions): Promise<void> {
    return this.boss.createQueue(name, options);
  }

  updateQueue(name: string, options?: QueueUpdateOptions): Promise<void> {
    return this.boss.updateQueue(name, options);
  }

  deleteQueue(name: string): Promise<void> {
    return this.boss.deleteQueue(name);
  }

  send<TData extends object>(
    name: string,
    data?: TData | null,
    options?: QueueSendOptions,
  ): Promise<string | null> {
    return this.boss.send(name, data, options);
  }

  work<TData>(
    name: string,
    options: QueueWorkOptions,
    handler: (jobs: QueueJob<TData>[]) => Promise<unknown>,
  ): Promise<unknown> {
    return this.boss.work(name, options, handler);
  }

  findJobs<TData extends object>(
    name: string,
    options?: QueueFindJobsOptions,
  ): Promise<QueueJobWithMetadata<TData>[]> {
    return this.boss.findJobs(name, options);
  }

  cancel(name: string, id: string | string[]): Promise<unknown> {
    return this.boss.cancel(name, id);
  }

  fail(
    name: string,
    id: string | string[],
    data?: QueueFailure,
  ): Promise<unknown> {
    return this.boss.fail(name, id, data);
  }

  schedule<TData extends object>(
    name: string,
    cron: string,
    data?: TData | null,
    options?: QueueScheduleOptions,
  ): Promise<void> {
    return this.boss.schedule(name, cron, data, options);
  }

  unschedule(name: string, key?: string): Promise<void> {
    return this.boss.unschedule(name, key);
  }
}

export function createPgBossJobQueue(
  options: ConstructorOptions | string,
): PgBossJobQueue {
  if (typeof options === 'string') {
    return new PgBossJobQueue(new PgBoss(options));
  }

  return new PgBossJobQueue(new PgBoss(options));
}

export type {
  ConstructorOptions as PgBossConstructorOptions,
  FindJobsOptions as PgBossFindJobsOptions,
  ScheduleOptions as PgBossScheduleOptions,
  SendOptions as PgBossSendOptions,
  StopOptions as PgBossStopOptions,
  WorkOptions as PgBossWorkOptions,
};
