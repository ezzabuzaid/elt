import assert from 'node:assert/strict';
import { cp, mkdir, mkdtempDisposable, rm, writeFile } from 'node:fs/promises';
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
      models: [{ id: 'cohere-int8', title: 'Cohere' }],
    });
    const enabled = await client.callTool({
      name: 'apple_transcription_update',
      arguments: { model: 'cohere-int8' },
    });
    assert.equal(enabled.isError, undefined);
    using settings = new Settings(
      join(scratch.path, 'Library/Application Support/Context Compiler/Apple'),
    );
    assert.equal(settings.transcription(), 'cohere-int8');
    const unavailable = await client.callTool({
      name: 'apple_transcription_update',
      arguments: { model: 'missing' },
    });
    assert.equal(unavailable.isError, true);
    assert.equal(settings.transcription(), 'cohere-int8');
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

// A home where Handy installed the Cohere model, and the Apple store in it.
async function homeWithCohere(home: string) {
  const model = join(
    home,
    'Library/Application Support/com.pais.handy/models/cohere-int8',
  );
  await mkdir(model, { recursive: true });
  for (const name of [
    'cohere-encoder.int8.onnx',
    'cohere-encoder.int8.onnx.data',
    'cohere-decoder.int8.onnx',
    'tokens.txt',
  ])
    await writeFile(join(model, name), '');
  return {
    model,
    store: join(home, 'Library/Application Support/Context Compiler/Apple'),
  };
}

// One server in a home, as a chat in Codex starts it.
async function pageTool(home: string, name: string, args: object) {
  const client = new Client({ name: 'transcription-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('plugins/apple/server/main.mjs')],
    env: { HOME: home, PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: { ...args } });
  } finally {
    await client.close();
    await transport.close();
  }
}

test('a store moved to another Mac keeps its chosen model, found where Handy keeps it there', async () => {
  await using scratch = await mkdtempDisposable(
    join(tmpdir(), 'page-transcription-moved-'),
  );
  const before = await homeWithCohere(join(scratch.path, 'before'));
  const after = await homeWithCohere(join(scratch.path, 'after'));
  await pageTool(join(scratch.path, 'before'), 'apple_transcription_update', {
    model: 'cohere-int8',
  });

  // Migration Assistant copies the store to a home with another name; the
  // old Mac, and its Handy folder, are gone.
  await cp(before.store, after.store, { recursive: true });
  await rm(join(scratch.path, 'before'), { recursive: true });
  const listed = await pageTool(
    join(scratch.path, 'after'),
    'apple_transcription',
    {},
  );

  assert.equal(listed.isError, undefined);
  assert.deepEqual(listed.structuredContent, {
    selected: 'cohere-int8',
    models: [{ id: 'cohere-int8', title: 'Cohere' }],
  });
});
