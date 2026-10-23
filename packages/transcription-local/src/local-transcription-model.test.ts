import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { LocalTranscriptionModel } from './local-transcription-model.ts';

test('real decoding and native model failures reject, and disposal rejects further work', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'local-model-'),
  );
  const path = join(directory.path, 'silence.aiff');
  await promisify(execFile)('say', ['-o', path, '[[slnc 100]]']);
  await using model = new LocalTranscriptionModel({
    name: 'cohere-transcribe-arabic-07-2026',
    path: join(directory.path, 'missing.gguf'),
    language: 'ar',
  });
  const audio = await readFile(path);
  await assert.rejects(
    model.doGenerate({ audio, mediaType: 'audio/aiff' }),
    /Local transcription exited/,
  );
  // A failed worker can be recreated for the next request.
  await assert.rejects(
    model.doGenerate({
      audio: audio.toString('base64'),
      mediaType: 'audio/aiff',
    }),
    /Local transcription exited/,
  );
  await assert.rejects(
    model.doGenerate({
      audio: Buffer.from('bad audio'),
      mediaType: 'audio/ogg',
    }),
    /afconvert/,
  );
  await model[Symbol.asyncDispose]();
  await assert.rejects(model.doGenerate({ audio, mediaType: 'audio/aiff' }), {
    name: 'AbortError',
  });
});

test('a cancelled queued call never loads a model and invalid configuration is refused', async () => {
  await using model = new LocalTranscriptionModel({
    name: 'cohere-transcribe-arabic-07-2026',
    path: '/nonexistent.gguf',
    language: 'ar',
  });
  await assert.rejects(
    model.doGenerate({
      audio: new Uint8Array(),
      mediaType: 'audio/wav',
      abortSignal: AbortSignal.abort(),
    }),
    { name: 'AbortError' },
  );
  assert.throws(() =>
    LocalTranscriptionModel.parse({
      name: 'cohere-transcribe-arabic-07-2026',
      path: '/models/cohere.gguf',
      language: '',
    }),
  );
  assert.throws(() =>
    LocalTranscriptionModel.parse({
      name: 'cohere-transcribe-arabic-07-2026',
      path: '',
      language: 'ar',
    }),
  );
});

test('a model is named by its name and language, not by where its file is, so a store moved to another Mac keeps its transcripts', async () => {
  const at = (
    path: string,
    name = 'cohere-transcribe-arabic-07-2026',
    language = 'ar',
  ) => new LocalTranscriptionModel({ name, path, language });
  await using here = at('/Users/ada/.cache/huggingface/hub/cohere.gguf');
  await using moved = at('/Users/grace/.cache/huggingface/hub/cohere.gguf');
  await using other = at(
    '/Users/ada/.cache/huggingface/hub/cohere.gguf',
    'other',
  );
  await using english = at(
    '/Users/ada/.cache/huggingface/hub/cohere.gguf',
    'cohere-transcribe-arabic-07-2026',
    'en',
  );

  // A model that detects the language itself is told none.
  await using unspecified = new LocalTranscriptionModel({
    name: 'cohere-transcribe-arabic-07-2026',
    path: '/Users/ada/.cache/huggingface/hub/cohere.gguf',
  });

  assert.equal(moved.modelId, here.modelId);
  assert.notEqual(other.modelId, here.modelId);
  assert.notEqual(english.modelId, here.modelId);
  assert.notEqual(unspecified.modelId, here.modelId);
});
