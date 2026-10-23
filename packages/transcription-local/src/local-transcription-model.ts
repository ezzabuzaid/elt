import { execFile } from 'node:child_process';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type {
  TranscriptionModelV4,
  TranscriptionModelV4CallOptions,
  TranscriptionModelV4Result,
} from '@ai-sdk/provider';
import PQueue from 'p-queue';
import { z } from 'zod';

import { TranscriptionWorker } from './transcription-worker.ts';

const execute = promisify(execFile);
// A model is its name and the language it is told the speech is in; the path
// only says where its file is on this Mac, so a store moved to another Mac
// keeps the transcripts it made.
const configuration = z.strictObject({
  name: z.string().min(1),
  path: z.string().min(1),
  language: z.string().min(1),
});
export type LocalTranscriptionConfiguration = z.infer<typeof configuration>;

// A native model implements the same AI SDK contract as a hosted provider.
// The owner disposes it after its imports finish; one worker reuses the weights
// across calls, and the queue prevents concurrent inference on that worker.
export class LocalTranscriptionModel
  implements TranscriptionModelV4, AsyncDisposable
{
  readonly specificationVersion = 'v4';
  readonly provider = 'transcribe-cpp';
  readonly modelId: string;
  readonly #configuration: LocalTranscriptionConfiguration;
  readonly #helper: string;
  readonly #queue = new PQueue({ concurrency: 1 });
  readonly #stopped = new AbortController();
  #worker: TranscriptionWorker | undefined;

  constructor(
    options: LocalTranscriptionConfiguration,
    helper = fileURLToPath(new URL('transcribe-local', import.meta.url)),
  ) {
    this.#configuration = {
      ...LocalTranscriptionModel.parse(options),
      path: resolve(options.path),
    };
    this.#helper = helper;
    this.modelId = JSON.stringify({
      name: this.#configuration.name,
      language: this.#configuration.language,
    });
  }

  static parse(value: unknown): LocalTranscriptionConfiguration {
    return configuration.parse(value);
  }

  // Check dependencies before a host saves an enabled model, without loading
  // its weights just to open settings.
  async check(): Promise<void> {
    await execute(this.#helper, ['--help']);
    await execute('ffmpeg', ['-version']).catch((cause: unknown) => {
      throw new Error(
        'Local audio transcription requires ffmpeg on PATH. Install it with brew install ffmpeg.',
        { cause },
      );
    });
  }

  doGenerate(
    options: TranscriptionModelV4CallOptions,
  ): Promise<TranscriptionModelV4Result> {
    const signal =
      options.abortSignal === undefined
        ? this.#stopped.signal
        : AbortSignal.any([this.#stopped.signal, options.abortSignal]);
    return this.#queue.add(async () => {
      signal.throwIfAborted();
      const timestamp = new Date();
      await using temporary = await mkdtempDisposable(
        join(tmpdir(), 'transcribe-local-'),
      );
      const audio = join(temporary.path, 'input');
      const pcm = join(temporary.path, 'audio.pcm');
      await writeFile(
        audio,
        typeof options.audio === 'string'
          ? Buffer.from(options.audio, 'base64')
          : options.audio,
        { signal },
      );
      // Decode WhatsApp's Opus and other supported inputs to the engine's
      // required 16 kHz, mono, 32-bit float samples using ffmpeg's codecs.
      await execute(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-i',
          audio,
          '-vn',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-f',
          'f32le',
          pcm,
        ],
        { signal },
      );
      signal.throwIfAborted();
      if (this.#worker?.dead) {
        await this.#worker.close();
        this.#worker = undefined;
      }
      this.#worker ??= new TranscriptionWorker(
        this.#helper,
        this.#configuration,
      );
      const worker = this.#worker;
      const abort = () => worker.kill();
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        const { text } = await worker.read(pcm);
        signal.throwIfAborted();
        // Cohere marks no timings, so the transcript has no segments.
        return {
          text,
          segments: [],
          language: undefined,
          durationInSeconds: undefined,
          warnings: [],
          response: { timestamp, modelId: this.modelId },
        };
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) {
          worker.kill();
          await worker.close();
        }
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stopped.abort();
    this.#worker?.kill();
    await this.#worker?.close();
    await this.#queue.onIdle();
  }
}
