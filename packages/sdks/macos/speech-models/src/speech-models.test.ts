import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtempDisposable,
  open,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Parallel, Pool } from '@workspace/pool';
import { LocalTranscriptionModel } from '@workspace/transcription-local';
import { TranscriptionWorker } from '@workspace/transcription-local/transcription-worker';

import type { SpeechModel } from './speech-model.ts';
import { SpeechModels } from './speech-models.ts';

// A GGUF header, as GGUF version 3 lays it out: the magic, the version, the
// tensor count, the key count, then each key with its string value (type 8).
function ggufHeader(metadata: Record<string, string>): Buffer {
  const u32 = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(value);
    return bytes;
  };
  const u64 = (value: number) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    return bytes;
  };
  const text = (value: string) =>
    Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);
  const entries = Object.entries(metadata);
  return Buffer.concat([
    Buffer.from('GGUF'),
    u32(3),
    u64(0),
    u64(entries.length),
    ...entries.flatMap(([key, value]) => [text(key), u32(8), text(value)]),
  ]);
}

test('discovery lists every speech model in the Hugging Face cache once, named by the catalog or the file, and skips other models and files', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'speech-models-'),
  );
  const hub = join(directory.path, 'hub');
  const home = join(directory.path, 'home');
  // Spotlight indexes no temporary folder, so this home adds nothing.
  await mkdir(home);
  const repository = (name: string, revision: string) =>
    join(hub, `models--${name}`, 'snapshots', revision);
  const write = async (path: string, bytes: Buffer) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, bytes);
  };
  const cohere = join(
    repository('handy-computer--cohere-transcribe-arabic-07-2026-gguf', 'a1'),
    'cohere-transcribe-arabic-07-2026-Q8_0.gguf',
  );
  await write(cohere, ggufHeader({ 'general.architecture': 'cohere_asr' }));
  // hf-hub links each snapshot's file to a blob; another revision of the
  // same file is the same model.
  await mkdir(
    repository('handy-computer--cohere-transcribe-arabic-07-2026-gguf', 'b2'),
    { recursive: true },
  );
  await symlink(
    cohere,
    join(
      repository('handy-computer--cohere-transcribe-arabic-07-2026-gguf', 'b2'),
      'cohere-transcribe-arabic-07-2026-Q8_0.gguf',
    ),
  );
  // Another quant of the same model is told Arabic too; another catalog model
  // of the same architecture is told no language.
  const quant = join(
    repository('handy-computer--cohere-transcribe-arabic-07-2026-gguf', 'a1'),
    'cohere-transcribe-arabic-07-2026-Q4_K_M.gguf',
  );
  await write(quant, ggufHeader({ 'general.architecture': 'cohere_asr' }));
  const multilingual = join(
    repository('handy-computer--cohere-transcribe-03-2026-gguf', 'h8'),
    'cohere-transcribe-03-2026-Q8_0.gguf',
  );
  await write(
    multilingual,
    ggufHeader({ 'general.architecture': 'cohere_asr' }),
  );
  const parakeet = join(
    repository('someone--parakeet-arabic-gguf', 'c3'),
    'nested/parakeet-arabic.gguf',
  );
  await write(
    parakeet,
    ggufHeader({
      'general.architecture': 'parakeet',
      'general.name': 'Parakeet Arabic',
    }),
  );
  const whisper = join(
    repository('ggerganov--whisper.cpp', 'd4'),
    'ggml-small.en.bin',
  );
  await write(whisper, Buffer.from('lmgg\u0000\u0001'));
  await write(
    join(repository('LiquidAI--LFM2.5-1.2B-Instruct-GGUF', 'e5'), 'lfm.gguf'),
    ggufHeader({ 'general.architecture': 'lfm2' }),
  );
  await write(
    join(repository('someone--weights', 'f6'), 'pytorch_model.bin'),
    Buffer.from('PK\u0003\u0004'),
  );
  await write(
    join(repository('someone--partial-gguf', 'g7'), 'partial.gguf'),
    Buffer.from('GGUF'),
  );
  const models = new SpeechModels({ hub, home });

  const listed = await models.list();

  assert.deepEqual(
    listed.map(({ id, title, configuration }) => ({
      id,
      title,
      configuration,
    })),
    [
      {
        id: 'cohere-transcribe-03-2026-Q8_0.gguf',
        title: 'Cohere Transcribe',
        configuration: {
          name: 'cohere-transcribe-03-2026-Q8_0.gguf',
          path: multilingual,
        },
      },
      {
        id: 'cohere-transcribe-arabic-07-2026-Q8_0.gguf',
        title: 'Cohere Transcribe Arabic',
        configuration: {
          name: 'cohere-transcribe-arabic-07-2026-Q8_0.gguf',
          path: cohere,
          language: 'ar',
        },
      },
      {
        id: 'cohere-transcribe-arabic-07-2026-Q4_K_M.gguf',
        title: 'Cohere Transcribe Arabic Q4_K_M',
        configuration: {
          name: 'cohere-transcribe-arabic-07-2026-Q4_K_M.gguf',
          path: quant,
          language: 'ar',
        },
      },
      {
        id: 'ggml-small.en.bin',
        title: 'ggml-small.en',
        configuration: { name: 'ggml-small.en.bin', path: whisper },
      },
      {
        id: 'parakeet-arabic.gguf',
        title: 'Parakeet Arabic',
        configuration: { name: 'parakeet-arabic.gguf', path: parakeet },
      },
    ],
  );
  assert.equal(
    (await models.find('parakeet-arabic.gguf'))?.configuration.path,
    parakeet,
  );
  assert.equal(await models.find('lfm.gguf'), undefined);
});

// Speech models are large downloads, so these run where one is installed.
// macOS's own voices stand in for a voice note.
async function installed(
  t: TestContext,
  wanted: (model: SpeechModel) => boolean,
  missing: string,
): Promise<SpeechModel | undefined> {
  if (process.platform !== 'darwin') {
    t.skip('macOS voices require macOS');
    return undefined;
  }
  const model = (await new SpeechModels().list()).find(wanted);
  if (model === undefined) t.skip(missing);
  return model;
}

async function transcribe(
  model: SpeechModel,
  voice: string,
  text: string,
): Promise<string> {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'speech-say-'),
  );
  const path = join(directory.path, 'note.aiff');
  await promisify(execFile)('say', ['-v', voice, '-o', path, text]);
  await using engines = new Pool({
    size: 1,
    startup: new Parallel(),
    create: () =>
      new TranscriptionWorker(
        fileURLToPath(
          import.meta
            .resolve('@workspace/transcription-local/transcribe-local'),
        ),
        model.configuration,
      ),
  });
  const local = new LocalTranscriptionModel(model.configuration, engines);
  const result = await local.doGenerate({
    audio: await readFile(path),
    mediaType: 'audio/aiff',
  });
  return result.text;
}

const cohereArabic = ({ id }: SpeechModel) =>
  id === 'cohere-transcribe-arabic-07-2026-Q8_0.gguf';

test('Cohere Transcribe Arabic writes Arabic speech in Arabic script and keeps English speech in English', async (t) => {
  const model = await installed(
    t,
    cohereArabic,
    'Cohere Transcribe Arabic is not installed',
  );
  if (model === undefined) return;

  const arabic = await transcribe(
    model,
    'Majed',
    'مرحبا، هذه رسالة صوتية قصيرة من صديقك.',
  );
  const english = await transcribe(
    model,
    'Samantha',
    'Please bring the blue umbrella when you come to the library tomorrow morning.',
  );

  assert.match(arabic, /رسالة صوتية/);
  assert.doesNotMatch(arabic, /[A-Za-z]/);
  assert.match(english, /blue umbrella/i);
  assert.match(english, /library/i);
  assert.doesNotMatch(english, /\p{Script=Arabic}/u);
});

test('Cohere Transcribe Arabic transcribes a voice note of over two minutes word for word, with nothing lost where it is cut', async (t) => {
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

  const model = await installed(
    t,
    cohereArabic,
    'Cohere Transcribe Arabic is not installed',
  );
  if (model === undefined) return;

  const heard = await transcribe(model, 'Samantha', said);

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

test('a model told no language, such as Whisper, recognizes English speech itself', async (t) => {
  const model = await installed(
    t,
    ({ configuration }) => configuration.language === undefined,
    'no speech model that is told no language is installed',
  );
  if (model === undefined) return;

  const english = await transcribe(
    model,
    'Samantha',
    'Please bring the blue umbrella when you come to the library tomorrow morning.',
  );

  assert.match(english, /blue umbrella/i);
});

test('discovery lists the whisper.cpp models Spotlight indexes outside the Hugging Face cache', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Spotlight requires macOS');
  const { stdout } = await promisify(execFile)('/usr/bin/mdfind', [
    '-onlyin',
    homedir(),
    'kMDItemFSName == "*.bin"c',
  ]);
  const indexed = [];
  for (const path of stdout.split('\n').filter(Boolean)) {
    await using file = await open(path);
    const { buffer } = await file.read(Buffer.alloc(4), 0, 4, 0);
    if (buffer.toString('latin1') === 'lmgg') indexed.push(basename(path));
  }
  if (indexed.length === 0)
    return t.skip('Spotlight indexes no whisper.cpp model on this Mac');

  const listed = (await new SpeechModels().list()).map(({ id }) => id);

  for (const id of indexed) assert.ok(listed.includes(id), id);
});
