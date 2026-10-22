import { readFile } from 'node:fs/promises';

import { type TranscriptionModel, transcribe } from 'ai';
import { fileTypeFromBuffer } from 'file-type';

import { DocumentFormat } from './document-format.ts';
import type { FileHead } from './file-head.ts';

// The model owns inference and its credentials or local runtime. This format
// only recognizes audio and turns the model's result into searchable text.
export class AudioFormat extends DocumentFormat {
  readonly identity: string;
  readonly #model: Exclude<TranscriptionModel, string>;
  protected override readonly extensions = [
    'wav',
    'mp3',
    'm4a',
    'aac',
    'ogg',
    'opus',
    'flac',
    'aiff',
    'aif',
    'webm',
  ];

  constructor(model: Exclude<TranscriptionModel, string>) {
    super();
    this.#model = model;
    this.identity = JSON.stringify(['audio', model.provider, model.modelId]);
  }

  protected override async hasSignature(head: FileHead): Promise<boolean> {
    return (
      (await fileTypeFromBuffer(head.bytes))?.mime.startsWith('audio/') ?? false
    );
  }

  override async text(
    path: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const result = await transcribe({
      model: this.#model,
      audio: await readFile(path, { signal }),
      abortSignal: signal,
      // AttachmentText already schedules failed files for the next pass.
      maxRetries: 0,
    });
    return result.text.trim() || null;
  }
}
