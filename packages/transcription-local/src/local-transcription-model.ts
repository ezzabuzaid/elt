import { execFile } from 'node:child_process';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type {
  TranscriptionModelV4,
  TranscriptionModelV4CallOptions,
  TranscriptionModelV4Result,
} from '@ai-sdk/provider';
import type { Pool } from '@zukhruf/pool';
import { z } from 'zod';

import type { TranscriptionWorker } from './transcription-worker.ts';

const execute = promisify(execFile);
// A model is its name and the language it is told the speech is in, if any;
// the path only says where its file is on this Mac, so a store moved to
// another Mac keeps the transcripts it made.
const configuration = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  language: z.string().min(1).optional(),
});
export type LocalTranscriptionConfiguration = z.infer<typeof configuration>;

// A native model implements the same AI SDK contract as a hosted provider.
// It borrows engine workers from a pool its host owns and disposes; a worker
// keeps the weights loaded across calls and transcribes one file at a time.
export class LocalTranscriptionModel implements TranscriptionModelV4 {
  readonly specificationVersion = 'v4';
  readonly provider = 'transcribe-cpp';
  readonly modelId: string;
  readonly #engines: Pool<TranscriptionWorker>;

  constructor(
    options: LocalTranscriptionConfiguration,
    engines: Pool<TranscriptionWorker>,
  ) {
    const { name, language } = LocalTranscriptionModel.parse(options);
    this.modelId = JSON.stringify({ name, language });
    this.#engines = engines;
  }

  static parse(value: unknown): LocalTranscriptionConfiguration {
    return configuration.parse(value);
  }

  async doGenerate(
    options: TranscriptionModelV4CallOptions,
  ): Promise<TranscriptionModelV4Result> {
    const signal = options.abortSignal;
    signal?.throwIfAborted();
    const timestamp = new Date();
    await using temporary = await mkdtempDisposable(
      join(tmpdir(), 'transcribe-local-'),
    );
    const audio = join(temporary.path, 'input');
    const wav = join(temporary.path, 'audio.wav');
    await writeFile(
      audio,
      typeof options.audio === 'string'
        ? Buffer.from(options.audio, 'base64')
        : options.audio,
      { signal },
    );
    // macOS's own decoder reads WhatsApp's Opus and the other formats
    // AudioFormat accepts, so a Mac needs nothing installed. It writes the
    // engine's required 16 kHz, mono, 32-bit float samples through its best
    // sample rate converter; the default one cost recognized words. It runs
    // before the call borrows an engine, which then only transcribes.
    await execute(
      '/usr/bin/afconvert',
      [
        ...['-f', 'WAVE', '-d', 'LEF32@16000', '-c', '1'],
        ...['--src-complexity', 'bats', audio, wav],
      ],
      { signal },
    );
    const { text } = await this.#engines.use(
      (engine) => engine.read(wav),
      signal,
    );
    // Cohere marks no timings, so the transcript has no segments.
    return {
      text,
      segments: [],
      language: undefined,
      durationInSeconds: undefined,
      warnings: [],
      response: { timestamp, modelId: this.modelId },
    };
  }
}
