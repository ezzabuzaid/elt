import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { z } from 'zod';

import type { Worker } from '@workspace/pool';

import type { LocalTranscriptionConfiguration } from './local-transcription-model.ts';

const transcript = z.union([
  z.object({ text: z.string() }),
  z.object({ error: z.string() }),
]);

const execute = promisify(execFile);

// One native engine process, which loads the model's weights when it starts.
// JSON Lines over stdio keeps the engine independent of Node and avoids
// opening a server port. Each request receives exactly one response.
export class TranscriptionWorker implements Worker {
  readonly #child;
  readonly #lines;
  readonly #closed: Promise<Error>;
  #stderr = '';
  #dead = false;

  constructor(
    helper: string,
    { path, language }: LocalTranscriptionConfiguration,
  ) {
    this.#child = spawn(helper, [
      '--model',
      resolve(path),
      ...(language === undefined ? [] : ['--language', language]),
    ]);
    this.#lines = createInterface({ input: this.#child.stdout })[
      Symbol.asyncIterator
    ]();
    this.#child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-16384);
    });
    this.#closed = new Promise((finish) => {
      this.#child.once('error', (error) => {
        this.#dead = true;
        finish(error);
      });
      this.#child.once('close', (code, signal) => {
        this.#dead = true;
        finish(
          new Error(
            `Local transcription exited (${signal ?? code}): ${this.#stderr.trim()}`,
          ),
        );
      });
    });
    // A failed model load can close stdin before a request is written. The
    // process's close event carries the actionable engine error.
    this.#child.stdin.on('error', () => undefined);
  }

  // Checks that the engine runs on this Mac before a host saves an enabled
  // model, without loading any weights.
  static async check(helper: string): Promise<void> {
    await execute(helper, ['--help']);
  }

  get dead(): boolean {
    return this.#dead;
  }

  async read(path: string) {
    this.#child.stdin.write(JSON.stringify({ path }) + '\n');
    const next = await Promise.race([
      this.#lines.next(),
      this.#closed.then((error) => {
        throw error;
      }),
    ]);
    if (next.done) throw await this.#closed;
    const result = transcript.parse(JSON.parse(next.value));
    if ('error' in result) throw new Error(result.error);
    return result;
  }

  kill(): void {
    this.#dead = true;
    this.#child.kill('SIGKILL');
  }

  async close(): Promise<void> {
    this.#child.stdin.end();
    await this.#closed;
  }
}
