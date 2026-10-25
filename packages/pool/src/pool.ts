import PQueue from 'p-queue';

import type { Startup } from './startup.ts';
import type { Worker } from './worker.ts';

// A slot holds the worker it lends, or the creation of that worker.
interface Slot<T> {
  worker: Promise<T> | undefined;
  busy: boolean;
}

// Lends a fixed number of workers to jobs, one job per worker at a time. The
// startup decides when workers start; a dead worker is replaced when a job
// next needs its slot. The owner disposes the pool, which stops every worker.
export class Pool<T extends Worker> implements AsyncDisposable {
  readonly #create: () => T;
  readonly #startup: Startup;
  readonly #queue: PQueue;
  readonly #slots: Slot<T>[];
  readonly #workers = new Set<T>();
  readonly #stopped = new AbortController();
  // Settles when the workers the startup starts with the pool are ready.
  readonly ready: Promise<void>;

  constructor(options: { size: number; startup: Startup; create: () => T }) {
    this.#create = options.create;
    this.#startup = options.startup;
    this.#queue = new PQueue({ concurrency: options.size });
    this.#slots = Array.from({ length: options.size }, () => ({
      worker: options.startup.eager ? this.#spawn() : undefined,
      busy: false,
    }));
    this.ready = Promise.all(this.#slots.map(({ worker }) => worker)).then(
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
      const slot = this.#slots.find(({ busy }) => !busy)!;
      slot.busy = true;
      try {
        const worker = await abortable(this.#borrow(slot), stop);
        const kill = () => worker.kill();
        stop.addEventListener('abort', kill, { once: true });
        try {
          const result = await job(worker);
          stop.throwIfAborted();
          return result;
        } catch (error) {
          stop.throwIfAborted();
          throw error;
        } finally {
          stop.removeEventListener('abort', kill);
        }
      } finally {
        slot.busy = false;
      }
    });
  }

  async #borrow(slot: Slot<T>): Promise<T> {
    const creation = (slot.worker ??= this.#spawn());
    let worker: T;
    try {
      worker = await creation;
    } catch (error) {
      if (slot.worker === creation) slot.worker = undefined;
      throw error;
    }
    if (!worker.dead) return worker;
    if (slot.worker === creation) slot.worker = undefined;
    await this.#close(worker);
    return this.#borrow(slot);
  }

  #spawn(): Promise<T> {
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
    created.then(settle, settle);
    return created;
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
