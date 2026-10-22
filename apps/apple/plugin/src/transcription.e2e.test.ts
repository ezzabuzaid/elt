import assert from 'node:assert/strict';
import { mkdir, mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { Settings } from '@workspace/settings';

test('the bundled page tools discover models, save the selection and reject an unavailable model', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'page-transcription-'),
  );
  const model = join(
    scratch.path,
    'Library/Application Support/com.pais.handy/models/cohere-int8',
  );
  await mkdir(model, { recursive: true });
  // Only discovery runs: no connector is selected and no weights are loaded.
  for (const name of [
    'cohere-encoder.int8.onnx',
    'cohere-encoder.int8.onnx.data',
    'cohere-decoder.int8.onnx',
    'tokens.txt',
  ])
    await writeFile(join(model, name), '');
  const client = new Client({ name: 'transcription-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('plugins/apple/server/main.mjs')],
    env: { HOME: scratch.path, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const listed = await client.callTool({
      name: 'apple_transcription',
      arguments: {},
    });
    assert.equal(listed.isError, undefined);
    assert.deepEqual(listed.structuredContent, {
      selected: null,
      models: [
        {
          id: 'cohere-int8',
          title: 'Cohere',
          configuration: { engine: 'cohere', directory: model },
        },
      ],
    });
    const enabled = await client.callTool({
      name: 'apple_transcription_update',
      arguments: { model: 'cohere-int8' },
    });
    assert.equal(enabled.isError, undefined);
    using settings = new Settings(
      join(scratch.path, 'Library/Application Support/Context Compiler/Apple'),
    );
    assert.equal(settings.transcription()?.directory, model);
    const unavailable = await client.callTool({
      name: 'apple_transcription_update',
      arguments: { model: 'missing' },
    });
    assert.equal(unavailable.isError, true);
    assert.equal(settings.transcription()?.directory, model);
    const disabled = await client.callTool({
      name: 'apple_transcription_update',
      arguments: { model: null },
    });
    assert.equal(disabled.isError, undefined);
    assert.equal(settings.transcription(), null);
  } finally {
    await client.close();
    await transport.close();
  }
});
