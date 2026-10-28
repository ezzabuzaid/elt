import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

import { Coprocess } from '@zukhruf/coprocess';
import type { Worker } from '@zukhruf/pool';
import { z } from 'zod';

import type { LocalTranscriptionConfiguration } from './local-transcription-model.ts';

const transcript = z.union([
  z.object({ text: z.string() }),
  z.object({ error: z.string() }),
]);

const execute = promisify(execFile);

// One native engine process, which loads the model's weights when it starts.
// JSON Lines over stdio keeps the engine independent of Node and avoids
// opening a server port. Each request receives exactly one response.
export class TranscriptionWorker extends Coprocess implements Worker {
  constructor(
    helper: string,
    { path, language }: LocalTranscriptionConfiguration,
  ) {
    super(
      helper,
      [
        '--model',
        resolve(path),
        ...(language === undefined ? [] : ['--language', language]),
      ],
      { name: 'Local transcription' },
    );
  }

  // Checks that the engine runs on this Mac before a host saves an enabled
  // model, without loading any weights.
  static async check(helper: string): Promise<void> {
    await execute(helper, ['--help']);
  }

  async read(path: string) {
    const result = transcript.parse(await this.request({ path }));
    if ('error' in result) throw new Error(result.error);
    return result;
  }
}
