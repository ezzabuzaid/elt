import { resolve } from 'node:path';

import type { Clock } from '@zukhruf/async';
import { Coprocess } from '@zukhruf/coprocess';
import type { Worker } from '@zukhruf/pool';
import { z } from 'zod';

const response = z.union([
  z.object({ text: z.string().nullable() }),
  z.object({ error: z.string() }),
]);

// One native Vision process, which keeps its models loaded and answers each
// request with one line. Vision compiles its models once per helper binary and
// caches them, so a host pools these workers with LeaderFirst: the first fills
// that cache and the others read it.
export class VisionWorker extends Coprocess implements Worker {
  // The memory a host sizes its pool by: a worker's own and the allocations
  // Vision makes for it outside the process, with headroom for the imports.
  static readonly memory = 2 * 1024 ** 3;
  // The deadlines of the warm-up and of each read run on it.
  readonly #clock: Clock;

  constructor(helper: string, clock: Clock) {
    super(helper, [], { name: 'Vision worker' });
    this.#clock = clock;
  }

  // The helper says it is ready once its models are compiled. The pool asks
  // once, before it lends the worker, and waits without a time limit. A cold
  // compile took up to about 195 s, and Vision on macOS 27 can hang in its ANE
  // compile (semaphore_wait in VNCRImageReaderDetector, #3067), so a warm-up
  // that runs 10 minutes is killed: the read that waits for it fails, and the
  // next read starts a new worker.
  async ready(): Promise<void> {
    const deadline = this.#clock.setTimeout(() => this.kill(), 600_000);
    try {
      z.object({ ready: z.literal(true) }).parse(await this.receive());
    } finally {
      this.#clock.clearTimeout(deadline);
    }
  }

  // A pool lends only a ready worker, so the deadline times recognition, not
  // model compilation, which can take longer.
  async read(path: string): Promise<string | null> {
    const deadline = this.#clock.setTimeout(() => this.kill(), 120_000);
    try {
      const result = response.parse(
        await this.request({ path: resolve(path) }),
      );
      if ('error' in result) throw new Error(result.error);
      return result.text;
    } finally {
      this.#clock.clearTimeout(deadline);
    }
  }
}
