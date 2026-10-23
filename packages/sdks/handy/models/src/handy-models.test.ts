import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { promisify } from 'node:util';

import { LocalTranscriptionModel } from '@workspace/transcription-local';

import { HandyModels } from './handy-models.ts';

test('discovery finds the model where Handy downloads it, the pinned Hugging Face snapshot first, and skips partial or absent files', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'handy-models-'),
  );
  const hub = join(directory.path, 'hub');
  const models = join(directory.path, 'models');
  const handy = new HandyModels({ hub, models });
  const file = 'cohere-transcribe-arabic-07-2026-Q8_0.gguf';
  const repository = join(
    hub,
    'models--handy-computer--cohere-transcribe-arabic-07-2026-gguf',
  );
  const pinned = join(
    repository,
    'snapshots/715cbe09ca9b60fc1e497db1e4478fa9fcf4ac21',
    file,
  );
  // hf-hub links each snapshot's file to a blob named by its hash.
  const snapshot = async (path: string) => {
    await mkdir(join(path, '..'), { recursive: true });
    await symlink(join(repository, 'blobs/910de5c9'), path);
  };
  await mkdir(join(repository, 'blobs'), { recursive: true });
  await writeFile(join(repository, 'blobs/910de5c9'), '');
  await mkdir(models);

  assert.deepEqual(handy.list(), []);
  assert.deepEqual(
    handy.find('cohere-transcribe-arabic-07-2026')?.configuration,
    {
      name: 'cohere-transcribe-arabic-07-2026',
      path: pinned,
      language: 'ar',
    },
  );

  await writeFile(join(models, `${file}.partial`), '');
  assert.deepEqual(handy.list(), []);

  await writeFile(join(models, file), '');
  const [mirrored] = handy.list();
  assert.equal(mirrored?.id, 'cohere-transcribe-arabic-07-2026');
  assert.equal(mirrored?.title, 'Cohere Transcribe Arabic');
  assert.equal(mirrored?.configuration.path, join(models, file));

  const older = join(repository, 'snapshots/0123abcd', file);
  await snapshot(older);
  assert.equal(handy.list()[0]?.configuration.path, older);

  await snapshot(pinned);
  assert.equal(handy.list()[0]?.configuration.path, pinned);
  assert.equal(handy.find('cohere-int8'), undefined);
});

// The model is a 2.4 GB download, so these run where Handy has downloaded it.
// macOS's own voices stand in for a voice note.
async function transcribe(
  t: TestContext,
  voice: string,
  text: string,
): Promise<string | undefined> {
  if (process.platform !== 'darwin') {
    t.skip('macOS voices require macOS');
    return undefined;
  }
  const [model] = new HandyModels().list();
  if (model === undefined) {
    t.skip('Cohere Transcribe Arabic is not downloaded in Handy');
    return undefined;
  }
  await using directory = await mkdtempDisposable(join(tmpdir(), 'handy-say-'));
  const path = join(directory.path, 'note.aiff');
  await promisify(execFile)('say', ['-v', voice, '-o', path, text]);
  await using local = new LocalTranscriptionModel(model.configuration);
  const result = await local.doGenerate({
    audio: await readFile(path),
    mediaType: 'audio/aiff',
  });
  return result.text;
}

test("Handy's Cohere Transcribe Arabic writes Arabic speech in Arabic script and keeps English speech in English", async (t) => {
  const arabic = await transcribe(
    t,
    'Majed',
    'مرحبا، هذه رسالة صوتية قصيرة من صديقك.',
  );
  const english = await transcribe(
    t,
    'Samantha',
    'Please bring the blue umbrella when you come to the library tomorrow morning.',
  );
  if (arabic === undefined || english === undefined) return;

  assert.match(arabic, /رسالة صوتية/);
  assert.doesNotMatch(arabic, /[A-Za-z]/);
  assert.match(english, /blue umbrella/i);
  assert.match(english, /library/i);
  assert.doesNotMatch(english, /\p{Script=Arabic}/u);
});

test("Handy's Cohere Transcribe Arabic transcribes a voice note of over two minutes word for word, with nothing lost where it is cut", async (t) => {
  const places = ['London', 'Paris', 'Tokyo', 'Berlin', 'Madrid', 'Rome'];
  const things = ['a warm coat', 'fresh bread', 'a paper map', 'green tea'];
  const people = ['a teacher', 'a fisherman', 'a painter', 'a doctor'];
  const said = [
    ...places,
    ...['Cairo', 'Dubai', 'Sydney', 'Toronto', 'Chicago', 'Boston'],
    ...['Seattle', 'Denver', 'Dallas', 'Miami', 'Vienna', 'Prague'],
    ...['Dublin', 'Lisbon', 'Athens', 'Istanbul', 'Moscow', 'Beijing'],
    ...['Seoul', 'Bangkok', 'Singapore', 'Mumbai', 'Delhi', 'Nairobi'],
  ]
    .map(
      (place, index) =>
        `Next we reached ${place}, where we bought ${things[index % 4]} and talked with ${people[(index * 3) % 4]} about the weather.`,
    )
    .join(' ');

  const heard = await transcribe(t, 'Samantha', said);
  if (heard === undefined) return;

  // Articles are left out: the model sometimes writes "the" for "a".
  const words = (text: string) =>
    (text.toLowerCase().match(/[a-z]+/g) ?? []).filter(
      (word) => word !== 'a' && word !== 'the',
    );
  const transcript = words(heard);
  const missing = [];
  let at = 0;
  for (const word of words(said)) {
    const found = transcript.slice(at, at + 3).indexOf(word);
    if (found === -1) missing.push(word);
    else at += found + 1;
  }
  assert.deepEqual(missing, []);
});
