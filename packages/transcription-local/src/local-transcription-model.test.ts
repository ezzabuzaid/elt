import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Fixed, OnDemand, Parallel, Pool } from '@workspace/pool';

import { LocalTranscriptionModel } from './local-transcription-model.ts';
import { TranscriptionWorker } from './transcription-worker.ts';

const helper = fileURLToPath(
  import.meta.resolve('@workspace/transcription-local/transcribe-local'),
);

test('real decoding and native model failures reject, and disposing the engines rejects further work', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'local-model-'),
  );
  const path = join(directory.path, 'silence.aiff');
  await promisify(execFile)('say', ['-o', path, '[[slnc 100]]']);
  const configuration = {
    name: 'cohere-transcribe-arabic-07-2026',
    path: join(directory.path, 'missing.gguf'),
    language: 'ar',
  };
  await using engines = new Pool({
    size: new Fixed(1),
    startup: new Parallel(),
    create: () => new TranscriptionWorker(helper, configuration),
  });
  const model = new LocalTranscriptionModel(configuration, engines);
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
  await engines[Symbol.asyncDispose]();
  await assert.rejects(model.doGenerate({ audio, mediaType: 'audio/aiff' }), {
    name: 'AbortError',
  });
});

test('a cancelled call never borrows an engine and invalid configuration is refused', async () => {
  const configuration = {
    name: 'cohere-transcribe-arabic-07-2026',
    path: '/nonexistent.gguf',
    language: 'ar',
  };
  let engines = 0;
  await using pool = new Pool({
    size: new Fixed(1),
    startup: new OnDemand(),
    create: () => {
      engines++;
      return new TranscriptionWorker(helper, configuration);
    },
  });
  const model = new LocalTranscriptionModel(configuration, pool);
  await assert.rejects(
    model.doGenerate({
      audio: new Uint8Array(),
      mediaType: 'audio/wav',
      abortSignal: AbortSignal.abort(),
    }),
    { name: 'AbortError' },
  );
  assert.equal(engines, 0);
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
  await using engines = new Pool({
    size: new Fixed(1),
    startup: new OnDemand(),
    create: (): TranscriptionWorker => {
      throw new Error('Naming a model starts no engine');
    },
  });
  const at = (
    path: string,
    name = 'cohere-transcribe-arabic-07-2026',
    language = 'ar',
  ) => new LocalTranscriptionModel({ name, path, language }, engines);
  const here = at('/Users/ada/.cache/huggingface/hub/cohere.gguf');
  const moved = at('/Users/grace/.cache/huggingface/hub/cohere.gguf');
  const other = at('/Users/ada/.cache/huggingface/hub/cohere.gguf', 'other');
  const english = at(
    '/Users/ada/.cache/huggingface/hub/cohere.gguf',
    'cohere-transcribe-arabic-07-2026',
    'en',
  );

  // A model that detects the language itself is told none.
  const unspecified = new LocalTranscriptionModel(
    {
      name: 'cohere-transcribe-arabic-07-2026',
      path: '/Users/ada/.cache/huggingface/hub/cohere.gguf',
    },
    engines,
  );

  assert.equal(moved.modelId, here.modelId);
  assert.notEqual(other.modelId, here.modelId);
  assert.notEqual(english.modelId, here.modelId);
  assert.notEqual(unspecified.modelId, here.modelId);
});
