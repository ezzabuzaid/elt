import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { ALL_MODELS } from '@handy-computer/models';
import { gguf } from '@huggingface/gguf';

import type { LocalTranscriptionConfiguration } from '@workspace/transcription-local';

// Handy's catalog lists every model transcribe.cpp publishes, and each
// model's family is the architecture its GGUF names, so the catalog's
// transcription models carry every architecture that transcribes.
const transcribing = new Set(
  ALL_MODELS.filter(({ role }) => role === 'asr').map(({ family }) => family),
);

// A speech model file on this Mac. Its id is the file name, so a store moved
// to another Mac finds the same model there.
export class SpeechModel {
  readonly id: string;
  readonly title: string;
  readonly configuration: LocalTranscriptionConfiguration;

  private constructor(path: string, title: string, language?: string) {
    this.id = basename(path);
    this.title = title;
    this.configuration = {
      name: this.id,
      path,
      ...(language === undefined ? {} : { language }),
    };
  }

  // A GGUF whose architecture transcribes, or a whisper.cpp model, whose file
  // starts with "lmgg". Any other file is not a speech model.
  static async read(path: string): Promise<SpeechModel | undefined> {
    const stem = basename(path, extname(path));
    if (extname(path) !== '.gguf')
      return (await startsWith(path, 'lmgg'))
        ? new SpeechModel(path, stem)
        : undefined;
    const { metadata } = await gguf(path, { allowLocalFile: true });
    const architecture = metadata['general.architecture'];
    if (architecture === undefined || !transcribing.has(architecture))
      return undefined;
    for (const model of ALL_MODELS)
      for (const [quant, file] of Object.entries(model.files))
        if (basename(file.filename) === basename(path))
          return new SpeechModel(
            path,
            quant === model.quant ? model.name : `${model.name} ${quant}`,
            // Told the speech is Arabic, this model still writes English words
            // and sentences as spoken, so one language covers mixed Arabic and
            // English voice notes. Told English, it repeated a made-up
            // sentence on a mixed note.
            model.id === 'cohere-transcribe-arabic-07-2026' ? 'ar' : undefined,
          );
    return new SpeechModel(path, metadata['general.name'] ?? stem);
  }
}

async function startsWith(path: string, magic: string): Promise<boolean> {
  await using file = await open(path);
  const { buffer, bytesRead } = await file.read(
    Buffer.alloc(magic.length),
    0,
    magic.length,
    0,
  );
  return buffer.toString('latin1', 0, bytesRead) === magic;
}
