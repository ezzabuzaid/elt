import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';
import { DeprecatedRevisionError, Pool, WorkerKind } from '@zukhruf/pool';
import { MockTranscriptionModelV4 } from 'ai/test';

import { EscalatedFailure } from '@eltjs/elt';

import { AudioFormat } from './document-formats/audio-format.ts';
import { ImageFormat } from './document-formats/image-format.ts';
import { MacOSDocumentParser } from './macos-document-parser.ts';
import { visionKind } from './vision-kind.ts';

// A stored file as a storage gives it to identityFor: a name, and a head that
// gives the first bytes that the parser asks for.
function stored(name: string, content: string) {
  return {
    name,
    head: async (length: number) =>
      new TextEncoder().encode(content).subarray(0, length),
  };
}

test('identityFor names the format of a stored file by the extension of its name, or by the magic number in the head that it reads through the storage, and no format for a file that neither names', async () => {
  const parser = new MacOSDocumentParser();

  const identities = {
    pdf: await parser.identityFor(stored('GroupPhotoImage', '%PDF-1.7\n')),
    rtf: await parser.identityFor(stored('pluginPayload', '{\\rtf1 hello}')),
    text: await parser.identityFor(stored('note.TXT', 'plain words')),
    unknown: await parser.identityFor(stored('payload', 'plain words')),
  };

  assert.deepEqual(identities, {
    pdf: 'pdf-v1',
    rtf: 'text-v1',
    text: 'text-v1',
    unknown: null,
  });
});

// A Pool of kind on a store that already holds the next revision of kind, as
// the store of a Mac where a newer host started: the Pool is deprecated.
async function deprecated<Input, Output>(
  store: string,
  kind: WorkerKind<Input, Output>,
): Promise<Pool<Input, Output>> {
  const { name, revision, policy, retryLimit, expireInSeconds } = kind;
  await using newer = new Pool({
    kind: new WorkerKind<Input, Output>({
      name,
      revision: revision + 1,
      policy,
      retryLimit,
      expireInSeconds,
    }),
    store,
    clock: globalThis,
  });
  // A read waits for the start of the Pool, which creates the queue of its
  // revision in the store.
  await newer.stats();
  return new Pool({ kind, store, clock: globalThis });
}

// Checks the EscalatedFailure that a parse of a deprecated pool's read
// rejects with, as assert.rejects takes a check.
function escalatedFrom(kind: WorkerKind<unknown, unknown>) {
  return (error: unknown): true => {
    assert.ok(error instanceof EscalatedFailure, String(error));
    assert.ok(
      error.cause instanceof DeprecatedRevisionError,
      String(error.cause),
    );
    assert.deepEqual(
      {
        message: error.message,
        kind: error.cause.kind,
        revision: error.cause.revision,
        newest: error.cause.newest,
      },
      {
        message: error.cause.message,
        kind: kind.name,
        revision: kind.revision,
        newest: kind.revision + 1,
      },
    );
    return true;
  };
}

test('a parse of an image whose OCR pool is deprecated, because the store holds a newer revision of its kind, rejects with an EscalatedFailure whose cause is the DeprecatedRevisionError of the pool', async () => {
  await using folder = await new TemporaryFiles().directory('macos-parser-');
  await using ocr = await deprecated(
    join(folder.path, 'store.sqlite'),
    visionKind,
  );
  const image = join(folder.path, 'scan.png');
  await writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  const parser = new MacOSDocumentParser([new ImageFormat(ocr)]);

  await assert.rejects(parser.parse(image), escalatedFrom(visionKind));
});

test('a parse of audio whose speech model reads through a deprecated pool rejects with an EscalatedFailure whose cause is the DeprecatedRevisionError of the pool, as the AI SDK rethrows the error of the model unchanged when it makes no retries', async () => {
  await using folder = await new TemporaryFiles().directory('macos-parser-');
  const speechKind = new WorkerKind<{ path: string }, { text: string }>({
    name: 'speech',
    revision: 1,
    policy: 'exclusive',
    retryLimit: 0,
    expireInSeconds: 60,
  });
  await using speech = await deprecated(
    join(folder.path, 'store.sqlite'),
    speechKind,
  );
  const audio = join(folder.path, 'message.wav');
  await writeFile(audio, Buffer.from([0, 1, 2, 3]));
  // A local model sends each file to the pool of its kind, as
  // LocalTranscriptionModel of @eltjs/transcription-local does; the AI SDK's
  // own stand-in is the model, so transcribe runs for real.
  const model = new MockTranscriptionModelV4({
    doGenerate: async ({ abortSignal }) => {
      const { text } = await speech.run(
        { path: audio },
        { signal: abortSignal },
      );
      return {
        text,
        segments: [],
        language: undefined,
        durationInSeconds: undefined,
        warnings: [],
        response: { timestamp: new Date(), modelId: 'test' },
      };
    },
  });
  const parser = new MacOSDocumentParser([new AudioFormat(model)]);

  await assert.rejects(parser.parse(audio), escalatedFrom(speechKind));
});

test('a parse of audio whose speech model fails for a reason other than a deprecated pool rejects with that error itself, not an EscalatedFailure, so the file fails alone', async () => {
  await using folder = await new TemporaryFiles().directory('macos-parser-');
  const audio = join(folder.path, 'message.wav');
  await writeFile(audio, Buffer.from([0, 1, 2, 3]));
  const refusal = new Error('the speech model cannot read this file');
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => {
      throw refusal;
    },
  });
  const parser = new MacOSDocumentParser([new AudioFormat(model)]);

  const error = await parser.parse(audio).then(
    () => assert.fail('the parse reported no failure'),
    (error: unknown) => error,
  );

  assert.equal(error, refusal);
});
