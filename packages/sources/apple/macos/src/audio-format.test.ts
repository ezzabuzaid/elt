import assert from 'node:assert/strict';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MockTranscriptionModelV4 } from 'ai/test';

import { AudioFormat } from './document-formats/audio-format.ts';
import { MacOSDocumentParser } from './macos-document-parser.ts';

// A remote provider cannot deterministically return silence, errors and exact
// text offline. AI SDK's own stand-in replaces that boundary; transcribe and
// file dispatch run for real.
test('an injected model transcribes audio, leaves native text parsing intact and receives cancellation', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'audio-format-'),
  );
  const audio = join(directory.path, 'message.opus');
  const text = join(directory.path, 'note.txt');
  const unknown = join(directory.path, 'unknown');
  const bytes = Buffer.from([0, 1, 2, 3]);
  await writeFile(audio, bytes);
  await writeFile(text, 'An unchanged document');
  await writeFile(unknown, bytes);
  const abort = new AbortController();
  let calls = 0;
  const model = new MockTranscriptionModelV4({
    doGenerate: async (options) => {
      calls++;
      assert.deepEqual(Buffer.from(options.audio), bytes);
      assert.ok(options.abortSignal);
      assert.equal(options.abortSignal.aborted, false);
      return {
        text: '  Meet tomorrow  ',
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId: 'test' },
      };
    },
  });
  const parser = new MacOSDocumentParser([new AudioFormat(model)]);
  assert.equal(await parser.parse(audio, abort.signal), 'Meet tomorrow');
  assert.equal(await parser.parse(text), 'An unchanged document');
  assert.equal(await parser.parse(unknown), null);
  assert.equal(
    await parser.identityFor(text),
    await new MacOSDocumentParser().identityFor(text),
  );
  assert.equal(await new MacOSDocumentParser().parse(audio), null);
  abort.abort();
  await assert.rejects(parser.parse(audio, abort.signal), {
    name: 'AbortError',
  });
  assert.equal(calls, 1);
});

test('empty transcripts become null and provider failures propagate without automatic retries', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'audio-format-'),
  );
  const audio = join(directory.path, 'audio.wav');
  await writeFile(audio, Buffer.from([0, 1]));
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => ({
      text: '   ',
      segments: [],
      language: undefined,
      durationInSeconds: undefined,
      warnings: [],
      response: { timestamp: new Date(), modelId: 'test' },
    }),
  });
  const parser = new MacOSDocumentParser([new AudioFormat(model)]);
  assert.equal(await parser.parse(audio), null);
  let calls = 0;
  model.doGenerate = async () => {
    calls++;
    throw new Error('Model unavailable');
  };
  await assert.rejects(parser.parse(audio), /Model unavailable/);
  assert.equal(calls, 1);
});
