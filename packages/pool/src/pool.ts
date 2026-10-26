import PQueue from 'p-queue';

import type { Sizing } from './sizing.ts';
import type { Startup } from './startup.ts';
import type { Worker } from './worker.ts';

// A slot holds the worker it lends, or the creation of that worker. ready is
// true while that worker is ready and alive as far as the pool knows.
interface Slot<T> {
  readonly index: number;
  worker: Promise<T> | undefined;
  ready: boolean;
  busy: boolean;
}

// Lends workers to jobs, one job per worker at a time. The sizing decides how
// many workers run and the startup when they start; a dead worker is replaced
// when a job next needs its slot. The owner disposes the pool, which stops
// every worker.
export class Pool<T extends Worker> implements AsyncDisposable {
  readonly #create: () => T;
  readonly #startup: Startup;
  readonly #sizing: Sizing;
  readonly #queue: PQueue;
  readonly #slots: Slot<T>[];
  readonly #workers = new Set<T>();
  readonly #stopped = new AbortController();
  // Since when every slot the pool runs has had a ready worker.
  #steady: number | undefined;
  // Settles when the workers the startup starts with the pool are ready.
  readonly ready: Promise<void>;

  constructor(options: { size: Sizing; startup: Startup; create: () => T }) {
    this.#create = options.create;
    this.#startup = options.startup;
    this.#sizing = options.size;
    this.#queue = new PQueue({ concurrency: this.#sizing.current });
    this.#slots = Array.from({ length: this.#sizing.ceiling }, (_, index) => ({
      index,
      worker: undefined,
      ready: false,
      busy: false,
    }));
    const started = options.startup.eager ? this.#running() : [];
    for (const slot of started) slot.worker = this.#spawn(slot);
    this.ready = Promise.all(started.map(({ worker }) => worker)).then(
      () => undefined,
    );
    this.ready.catch(() => undefined);
  }

  // A job aborted while it runs kills its worker. A job aborted while its
  // worker warms up leaves the warm-up running for the jobs after it.
  use<R>(job: (worker: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    const stop =
      signal === undefined
        ? this.#stopped.signal
        : AbortSignal.any([this.#stopped.signal, signal]);
    if (stop.aborted) return Promise.reject(stop.reason);
    // The queue does not take the signal: on abort it would free the slot
    // while the job still holds its worker.
    return this.#queue.add(async () => {
      stop.throwIfAborted();
      const slot = this.#running().find(({ busy }) => !busy)!;
      slot.busy = true;
      try {
        const worker = await abortable(this.#borrow(slot), stop);
        const kill = () => {
          worker.kill();
          this.#lost(slot);
        };
        stop.addEventListener('abort', kill, { once: true });
        const started = performance.now();
        try {
          const result = await job(worker);
          stop.throwIfAborted();
          return result;
        } catch (error) {
          stop.throwIfAborted();
          throw error;
        } finally {
          stop.removeEventListener('abort', kill);
          if (!stop.aborted) this.#record(started);
        }
      } finally {
        slot.busy = false;
        if (slot.index >= this.#sizing.kept) this.#retire(slot);
      }
    });
  }

  #running(): Slot<T>[] {
    return this.#slots.slice(0, this.#sizing.current);
  }

  async #borrow(slot: Slot<T>): Promise<T> {
    const creation = (slot.worker ??= this.#spawn(slot));
    let worker: T;
    try {
      worker = await creation;
    } catch (error) {
      if (slot.worker === creation) slot.worker = undefined;
      throw error;
    }
    if (!worker.dead) return worker;
    if (slot.worker === creation) slot.worker = undefined;
    this.#lost(slot);
    await this.#close(worker);
    return this.#borrow(slot);
  }

  // A job measures how many workers pay only if, since it started, the pool
  // ran the same number of workers and each was ready, and another job waited
  // when it finished.
  #record(started: number): void {
    this.#sizing.record({
      started,
      finished: performance.now(),
      measurable:
        this.#steady !== undefined &&
        started >= this.#steady &&
        this.#queue.size > 0,
    });
    for (const slot of this.#slots.slice(this.#sizing.kept)) this.#retire(slot);
    if (this.#sizing.current === this.#queue.concurrency) return;
    this.#queue.concurrency = this.#sizing.current;
    for (const slot of this.#running()) slot.worker ??= this.#spawn(slot);
    this.#steady = undefined;
    this.#check();
  }

  #spawn(slot: Slot<T>): Promise<T> {
    slot.ready = false;
    this.#check();
    const settled = Promise.withResolvers<void>();
    const created = this.#startup.turn(settled.promise).then(async () => {
      this.#stopped.signal.throwIfAborted();
      const worker = this.#create();
      this.#workers.add(worker);
      try {
        await worker.ready;
        return worker;
      } catch (error) {
        worker.kill();
        await this.#close(worker);
        throw error;
      }
    });
    const settle = () => settled.resolve();
    created.then(() => {
      if (slot.worker === created) {
        slot.ready = true;
        this.#check();
      }
      settle();
    }, settle);
    return created;
  }

  #lost(slot: Slot<T>): void {
    slot.ready = false;
    this.#check();
  }

  // Closes the worker of a slot the pool no longer keeps, once its job ends.
  #retire(slot: Slot<T>): void {
    if (slot.busy || slot.worker === undefined) return;
    const creation = slot.worker;
    slot.worker = undefined;
    slot.ready = false;
    creation.then(
      (worker) => this.#close(worker),
      () => undefined,
    );
  }

  #check(): void {
    if (this.#running().every(({ ready }) => ready))
      this.#steady ??= performance.now();
    else this.#steady = undefined;
  }

  async #close(worker: T): Promise<void> {
    await worker.close();
    this.#workers.delete(worker);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stopped.abort();
    for (const worker of this.#workers) worker.kill();
    await Promise.all([...this.#workers].map((worker) => worker.close()));
    await this.#queue.onIdle();
  }
}

function abortable<V>(promise: Promise<V>, signal: AbortSignal): Promise<V> {
  const aborted = Promise.withResolvers<never>();
  const abort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  return Promise.race([promise, aborted.promise]).finally(() =>
    signal.removeEventListener('abort', abort),
  );
}
