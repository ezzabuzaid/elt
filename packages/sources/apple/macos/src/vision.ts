import { resolve } from 'node:path';

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

  constructor(helper: string) {
    super(helper, [], { name: 'Vision worker' });
  }

  // The helper says it is ready once its models are compiled. The pool asks
  // once, before it lends the worker.
  async ready(): Promise<void> {
    z.object({ ready: z.literal(true) }).parse(await this.receive());
  }

  // A pool lends only a ready worker, so the deadline times recognition, not
  // model compilation, which can take longer.
  async read(path: string): Promise<string | null> {
    const deadline = setTimeout(() => this.kill(), 120_000);
    try {
      const result = response.parse(
        await this.request({ path: resolve(path) }),
      );
      if ('error' in result) throw new Error(result.error);
      return result.text;
    } finally {
      clearTimeout(deadline);
    }
  }
}
