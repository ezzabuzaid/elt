import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HandyModels } from './handy-models.ts';

test('discovery lists complete supported downloads and excludes partial or absent models', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'handy-models-'),
  );
  const models = new HandyModels(directory.path);
  assert.deepEqual(await models.list(), []);
  const cohere = join(directory.path, 'cohere-int8');
  await mkdir(cohere);
  for (const name of [
    'cohere-encoder.int8.onnx',
    'cohere-decoder.int8.onnx',
    'tokens.txt',
  ])
    await writeFile(join(cohere, name), '');
  assert.deepEqual(await models.list(), []);
  await writeFile(join(cohere, 'cohere-encoder.int8.onnx.data'), '');
  const [model] = await models.list();
  assert.equal(model?.id, 'cohere-int8');
  assert.deepEqual(model?.configuration, {
    engine: 'cohere',
    directory: cohere,
  });
});
