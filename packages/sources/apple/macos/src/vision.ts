import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { z } from 'zod';

import type { Worker } from '@workspace/pool';

const response = z.union([
  z.object({ text: z.string().nullable() }),
  z.object({ error: z.string() }),
]);

// One native Vision process, which keeps its models loaded. JSON Lines over
// stdio follows the local transcription worker: no listener, one response per
// request, and the process exit carries native diagnostics. Vision compiles
// its models once per helper binary and caches them, so a host pools these
// workers with LeaderFirst: the first fills that cache and the others read it.
export class VisionWorker implements Worker {
  // The memory a host sizes its pool by: a worker's own and the allocations
  // Vision makes for it outside the process, with headroom for the imports.
  static readonly memory = 2 * 1024 ** 3;

  readonly #child;
  readonly #lines;
  readonly #closed: Promise<Error>;
  readonly ready: Promise<void>;
  #stderr = '';
  dead = false;

  constructor(helper: string) {
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

  // A pool lends only a ready worker, so the deadline times recognition, not
  // model compilation, which can take longer.
  async read(path: string): Promise<string | null> {
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
