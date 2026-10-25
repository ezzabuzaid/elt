import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import PQueue from 'p-queue';
import { z } from 'zod';

const response = z.union([
  z.object({ text: z.string().nullable() }),
  z.object({ error: z.string() }),
]);

export function visionConcurrency(cpus: number, memory: number): number {
  // Leave headroom for imports and Vision allocations outside worker RSS.
  return Math.max(1, Math.min(cpus, Math.floor(memory / (2 * 1024 ** 3))));
}

// Processes retain Vision's loaded models. The host starts and stops
// them with its other resources; parsers borrow them across imports.
export class Vision implements AsyncDisposable {
  readonly #helper: string;
  readonly #queue = new PQueue({
    concurrency: visionConcurrency(
      availableParallelism(),
      process.availableMemory(),
    ),
  });
  readonly #stopped = new AbortController();
  readonly #workers: { worker: VisionWorker; busy: boolean }[];

  constructor(helper: string) {
    this.#helper = helper;
    let previous = Promise.resolve();
    this.#workers = Array.from({ length: this.#queue.concurrency }, () => {
      const worker = new VisionWorker(helper, previous);
      // Keep the chain ordered even if a waiting worker exits before its turn.
      previous = previous.then(() => worker.ready).catch(() => undefined);
      return { worker, busy: false };
    });
  }

  get ready(): Promise<void> {
    return Promise.all(this.#workers.map(({ worker }) => worker.ready)).then(
      () => undefined,
    );
  }

  read(path: string, signal?: AbortSignal): Promise<string | null> {
    return this.#queue.add(async () => {
      this.#stopped.signal.throwIfAborted();
      signal?.throwIfAborted();
      const slot = this.#workers.find(({ busy }) => !busy)!;
      slot.busy = true;
      const abort = () => slot.worker.kill();
      try {
        // A native crash fails that file; the next file replaces only that worker.
        if (slot.worker.dead) {
          await slot.worker.close();
          this.#stopped.signal.throwIfAborted();
          signal?.throwIfAborted();
          slot.worker = new VisionWorker(
            this.#helper,
            Promise.allSettled(this.#workers.map(({ worker }) => worker.ready)),
          );
        }
        signal?.addEventListener('abort', abort, { once: true });
        const text = await slot.worker.read(path);
        signal?.throwIfAborted();
        return text;
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        signal?.removeEventListener('abort', abort);
        slot.busy = false;
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stopped.abort();
    for (const { worker } of this.#workers) worker.kill();
    await Promise.all(this.#workers.map(({ worker }) => worker.close()));
    await this.#queue.onIdle();
  }
}

// JSON Lines over stdio follows the local transcription worker: no listener,
// one response per request, and the process exit carries native diagnostics.
class VisionWorker {
  readonly #child;
  readonly #lines;
  readonly #closed: Promise<Error>;
  readonly ready: Promise<void>;
  #stderr = '';
  dead = false;

  constructor(helper: string, after: Promise<unknown>) {
    this.#child = spawn(helper);
    this.#lines = createInterface({ input: this.#child.stdout })[
      Symbol.asyncIterator
    ]();
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-16384);
    });
    this.#closed = new Promise((finish) => {
      this.#child.once('error', (error) => {
        this.dead = true;
        finish(error);
      });
      this.#child.once('exit', () => {
        this.dead = true;
      });
      this.#child.once('close', (code, signal) =>
        finish(
          new Error(
            `Vision worker exited (${signal ?? code}): ${this.#stderr.trim()}`,
          ),
        ),
      );
    });
    // A failed startup can close the pipe before a request is written.
    this.#child.stdin.on('error', () => undefined);
    this.ready = this.#next().then((value) => {
      z.object({ ready: z.literal(true) }).parse(value);
    });
    this.ready.catch(() => undefined);
    // Concurrent cold starts compile identical native models independently.
    void after.then(() => {
      if (!this.dead) this.#child.stdin.write('\n');
    });
  }

  async #next(): Promise<unknown> {
    const next = await Promise.race([
      this.#lines.next(),
      this.#closed.then((error) => {
        throw error;
      }),
    ]);
    if (next.done) throw await this.#closed;
    return JSON.parse(next.value);
  }

  async read(path: string): Promise<string | null> {
    await this.ready;
    // Model compilation can outlast an image read; only time a ready worker.
    const deadline = setTimeout(() => this.kill(), 120_000);
    try {
      this.#child.stdin.write(JSON.stringify({ path: resolve(path) }) + '\n');
      const result = response.parse(await this.#next());
      if ('error' in result) throw new Error(result.error);
      return result.text;
    } finally {
      clearTimeout(deadline);
    }
  }

  kill(): void {
    this.dead = true;
    this.#child.kill();
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await this.#closed;
  }
}
