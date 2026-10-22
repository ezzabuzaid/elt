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
const configuration = z.strictObject({
  engine: z.enum(['cohere', 'canary']),
  directory: z.string().min(1),
});
export type LocalTranscriptionConfiguration = z.infer<typeof configuration>;

// A native model implements the same AI SDK contract as a hosted provider.
// The owner disposes it after its imports finish; one worker reuses the weights
// across calls, and the queue prevents concurrent inference on that worker.
export class LocalTranscriptionModel
  implements TranscriptionModelV4, AsyncDisposable
{
  readonly specificationVersion = 'v4';
  readonly provider = 'transcribe-rs';
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
      directory: resolve(options.directory),
    };
    this.#helper = helper;
    this.modelId = JSON.stringify(this.#configuration);
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
      const language = z
        .object({ language: z.string().optional() })
        .parse(options.providerOptions?.['transcribe-rs'] ?? {}).language;
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
      // Decode WhatsApp's Opus and other supported inputs to the engine's
      // required 16 kHz, mono, signed 16-bit WAV using ffmpeg's codecs.
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
          '-c:a',
          'pcm_s16le',
          wav,
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
        const result = await worker.read(wav, language);
        signal.throwIfAborted();
        return {
          ...result,
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
