import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Settings } from '@workspace/settings';

test('the CLI saves an installed model in its chosen directory, rejects unknown models and can turn it off', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'cli-transcription-'),
  );
  const model = join(
    scratch.path,
    'Library/Application Support/com.pais.handy/models/cohere-int8',
  );
  await mkdir(model, { recursive: true });
  // Discovery reads the download's file names. No import is selected, so this
  // settings test does not load model weights.
  for (const name of [
    'cohere-encoder.int8.onnx',
    'cohere-encoder.int8.onnx.data',
    'cohere-decoder.int8.onnx',
    'tokens.txt',
  ])
    await writeFile(join(model, name), '');
  const directory = join(scratch.path, 'imports');
  const run = (id: string) =>
    spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, 'main.js'),
        '--directory',
        directory,
        '--transcription-model',
        id,
        'status',
      ],
      {
        env: { ...process.env, HOME: scratch.path },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
  const enabled = run('cohere-int8');
  assert.equal(enabled.status, 0, enabled.stderr);
  using settings = new Settings(directory);
  assert.deepEqual(settings.transcription(), {
    engine: 'cohere',
    directory: model,
  });
  assert.equal(run('missing').status, 1);
  assert.equal(settings.transcription()?.engine, 'cohere');
  const disabled = run('off');
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(settings.transcription(), null);
});
