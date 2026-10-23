import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

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

test('audio macOS cannot decode or that holds no speech never reaches the model, and Core Audio and AMR files without an extension do', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'audio-format-'),
  );
  const webm = join(directory.path, 'clip.webm');
  const midi = join(directory.path, 'tune');
  const spoken = join(directory.path, 'spoken.aiff');
  const caf = join(directory.path, 'Audio Message');
  // An AMR voice memo, as old phones and MMS send them, starts with "#!AMR".
  const amr = join(directory.path, 'Voice Memo');
  await writeFile(amr, Buffer.from('#!AMR\n<\u0000'));
  await writeFile(webm, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
  await writeFile(
    midi,
    Buffer.from([
      ...Buffer.from('MThd'),
      ...[0, 0, 0, 6, 0, 0, 0, 1, 0, 96],
      ...Buffer.from('MTrk'),
      ...[0, 0, 0, 4, 0, 0xff, 0x2f, 0],
    ]),
  );
  await promisify(execFile)('say', ['-o', spoken, 'hello']);
  await promisify(execFile)('afconvert', [
    '-f',
    'caff',
    '-d',
    'LEI16',
    spoken,
    caf,
  ]);
  let calls = 0;
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => {
      calls++;
      return {
        text: 'hello',
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId: 'test' },
      };
    },
  });
  const parser = new MacOSDocumentParser([new AudioFormat(model)]);

  assert.equal(await parser.parse(webm), null);
  assert.equal(await parser.parse(midi), null);
  assert.equal(calls, 0);
  assert.equal(await parser.parse(caf), 'hello');
  assert.equal(await parser.parse(amr), 'hello');
  assert.equal(calls, 2);
});
