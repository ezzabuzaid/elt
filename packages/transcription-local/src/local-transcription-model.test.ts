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
  const path = join(directory.path, 'silence.wav');
  await promisify(execFile)('ffmpeg', [
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '0.1',
    path,
  ]);
  await using model = new LocalTranscriptionModel({
    engine: 'cohere',
    directory: directory.path,
  });
  const audio = await readFile(path);
  await assert.rejects(
    model.doGenerate({ audio, mediaType: 'audio/wav' }),
    /Local transcription exited/,
  );
  // A failed worker can be recreated for the next request.
  await assert.rejects(
    model.doGenerate({
      audio: audio.toString('base64'),
      mediaType: 'audio/wav',
    }),
    /Local transcription exited/,
  );
  await assert.rejects(
    model.doGenerate({
      audio: Buffer.from('bad audio'),
      mediaType: 'audio/ogg',
    }),
    /ffmpeg/,
  );
  await model[Symbol.asyncDispose]();
  await assert.rejects(model.doGenerate({ audio, mediaType: 'audio/wav' }), {
    name: 'AbortError',
  });
});

test('a cancelled queued call never loads a model and invalid configuration is refused', async () => {
  await using model = new LocalTranscriptionModel({
    engine: 'canary',
    directory: '/nonexistent',
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
    LocalTranscriptionModel.parse({ engine: 'whisper', directory: '/models' }),
  );
  assert.throws(() =>
    LocalTranscriptionModel.parse({ engine: 'cohere', directory: '' }),
  );
});
