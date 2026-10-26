import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposable, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Fixed, LeaderFirst, Pool } from '@workspace/pool';

import { ImageFormat } from './document-formats/image-format.ts';
import { MacOSDocumentParser } from './macos-document-parser.ts';
import { VisionWorker } from './vision.ts';

const execute = promisify(execFile);
const workers = 3;

// One macrotask: a read entered the pool's queue and reached its worker.
// setImmediate is not one of the timers the deadline tests mock.
const inFlight = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

// The pool hosts build, sized to three workers on every Mac.
function ocr() {
  return new Pool({
    size: new Fixed(workers),
    startup: new LeaderFirst(),
    create: () =>
      new VisionWorker(
        fileURLToPath(new URL('vision-worker', import.meta.url)),
      ),
  });
}

async function workerPids() {
  const { stdout } = await execute('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
  return stdout
    .trim()
    .split('\n')
    .flatMap((line) => {
      const [pid, parent, command] = line.trim().split(/\s+/);
      return Number(parent) === process.pid &&
        command?.endsWith('/vision-worker')
        ? [Number(pid)]
        : [];
    });
}

// AppKit creates the fixture; the real parser and Vision read it.
async function image(path: string, text: string) {
  await execute('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    `
    ObjC.import('AppKit');
    const bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, 640, 160, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));
    $.NSColor.whiteColor.setFill;
    $.NSRectFill($.NSMakeRect(0, 0, 640, 160));
    const attributes = $.NSMutableDictionary.alloc.init;
    attributes.setObjectForKey($.NSFont.systemFontOfSize(40), $.NSFontAttributeName);
    attributes.setObjectForKey($.NSColor.blackColor, $.NSForegroundColorAttributeName);
    $(${JSON.stringify(text)}).drawAtPointWithAttributes($.NSMakePoint(20, 60), attributes);
    $.NSGraphicsContext.restoreGraphicsState;
    bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(${JSON.stringify(path)}, true);
  `,
  ]);
}

test('the warmed parser preserves OCR, concurrent responses and image errors, and recovers after its worker exits', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-parser-'),
  );
  const receipt = join(directory.path, 'receipt.thumb');
  const note = join(directory.path, 'note.png');
  const blank = join(directory.path, 'blank.png');
  const corrupt = join(directory.path, 'corrupt.png');
  await image(receipt, 'Invoice 4821 due Friday');
  await image(note, 'Meet tomorrow');
  await image(blank, '');
  await writeFile(corrupt, 'not an image');
  await using vision = ocr();
  await vision.ready;
  const pids = await workerPids();
  assert.equal(pids.length, workers);
  const parser = new MacOSDocumentParser([new ImageFormat(vision)]);
  assert.deepEqual(
    await Promise.all([
      parser.parse(receipt),
      parser.parse(note),
      parser.parse(blank),
    ]),
    ['Invoice 4821 due Friday', 'Meet tomorrow', null],
  );
  await assert.rejects(parser.parse(corrupt), /Cannot read image/);
  assert.equal(await parser.parse(note), 'Meet tomorrow');
  assert.deepEqual(await workerPids(), pids);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(parser.parse(note, stop.signal), { name: 'AbortError' });
  const pid = pids[0]!;
  const format = new ImageFormat(vision);
  const failed = assert.rejects(
    format.text(receipt),
    /Vision worker exited \(SIGKILL\)/,
  );
  const other = format.text(note);
  process.kill(pid, 'SIGKILL');
  await failed;
  assert.equal(await other, 'Meet tomorrow');
  assert.deepEqual(
    await Promise.all([parser.parse(receipt), parser.parse(note)]),
    ['Invoice 4821 due Friday', 'Meet tomorrow'],
  );
  const recovered = await workerPids();
  assert.equal(recovered.length, workers);
  assert.ok(!recovered.includes(pid));
  assert.ok(pids.slice(1).every((pid) => recovered.includes(pid)));
});

test('the first worker warms up alone and the others start together once it is ready', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-startup-order-'),
  );
  const path = join(directory.path, 'note.png');
  await image(path, 'Meet tomorrow');
  await using vision = ocr();
  const [leader, ...others] = await workerPids();
  assert.deepEqual(others, [], 'only the first worker may start');
  // A stopped leader models slow native compilation without clearing Apple's
  // shared cache. No other worker may race that compilation.
  process.kill(leader!, 'SIGSTOP');
  const parser = new MacOSDocumentParser([new ImageFormat(vision)]);
  const reads = Promise.all(
    Array.from({ length: workers }, () => parser.parse(path)),
  );
  reads.catch(() => undefined);
  try {
    await setTimeout(3_000);
    assert.deepEqual(await workerPids(), [leader]);
  } finally {
    process.kill(leader!, 'SIGCONT');
  }
  await vision.ready;
  const pids = await workerPids();
  assert.equal(pids.length, workers);
  assert.ok(pids.includes(leader!));
  assert.deepEqual(
    await reads,
    Array.from({ length: workers }, () => 'Meet tomorrow'),
  );
  assert.deepEqual(await workerPids(), pids);
});

test('cancelling a read while the first worker warms up keeps that warm-up for later reads', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-startup-cancel-'),
  );
  const path = join(directory.path, 'note.png');
  await image(path, 'Meet tomorrow');
  await using vision = ocr();
  const [leader] = await workerPids();
  process.kill(leader!, 'SIGSTOP');
  const format = new ImageFormat(vision);
  const stop = new AbortController();
  try {
    const cancelled = assert.rejects(format.text(path, stop.signal), {
      name: 'AbortError',
    });
    stop.abort();
    await cancelled;
  } finally {
    process.kill(leader!, 'SIGCONT');
  }
  await vision.ready;
  assert.ok((await workerPids()).includes(leader!));
  assert.equal(await format.text(path), 'Meet tomorrow');
});

test('the parser waits for slow OCR warm-up beyond the image deadline and reuses its workers', async (t) => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-cold-start-'),
  );
  const path = join(directory.path, 'note.png');
  await image(path, 'Meet tomorrow');
  // Apple's shared compiler cache cannot be reset in a test. Hold the leader
  // before readiness and advance only the host clock through the cold start.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await using vision = ocr();
    const ready = vision.ready;
    let warmed = false;
    ready.then(
      () => {
        warmed = true;
      },
      () => undefined,
    );
    const [leader] = await workerPids();
    process.kill(leader!, 'SIGSTOP');
    try {
      assert.equal(warmed, false, 'the leader must still be warming up');
      t.mock.timers.tick(120_001);
    } finally {
      process.kill(leader!, 'SIGCONT');
    }
    await ready;
    const pids = await workerPids();
    assert.equal(pids.length, workers);
    assert.ok(pids.includes(leader!));
    const parser = new MacOSDocumentParser([new ImageFormat(vision)]);
    assert.equal(await parser.parse(path), 'Meet tomorrow');
    assert.deepEqual(await workerPids(), pids);
  } finally {
    t.mock.timers.reset();
  }
});

test('an image still times out after warm-up and the next read replaces its worker', async (t) => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-timeout-'),
  );
  const path = join(directory.path, 'note.png');
  await image(path, 'Meet tomorrow');
  await using vision = ocr();
  await vision.ready;
  const pids = await workerPids();
  const format = new ImageFormat(vision);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const pid of pids) process.kill(pid, 'SIGSTOP');
  const failed = assert.rejects(
    format.text(path),
    /Vision worker exited \(SIGTERM\)/,
  );
  try {
    // Let the ready worker start the read before advancing its deadline.
    await inFlight();
    t.mock.timers.tick(120_001);
  } finally {
    for (const pid of pids) process.kill(pid, 'SIGCONT');
    t.mock.timers.reset();
  }
  await failed;
  assert.equal(await format.text(path), 'Meet tomorrow');
  const recovered = await workerPids();
  assert.equal(recovered.length, pids.length);
  assert.equal(
    recovered.filter((pid) => pids.includes(pid)).length,
    pids.length - 1,
  );
});

test('disposing OCR during warm-up rejects readiness and stops every worker', async () => {
  await using vision = ocr();
  while ((await workerPids()).length === 0) await setTimeout(10);
  const ready = assert.rejects(
    vision.ready,
    /Vision worker exited \(SIGTERM\)/,
  );
  await vision[Symbol.asyncDispose]();
  await ready;
  assert.deepEqual(await workerPids(), []);
});

test('the ready parser preserves automatically detected multilingual text in all reused workers', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-languages-'),
  );
  await using vision = ocr();
  await vision.ready;
  const pids = await workerPids();
  assert.equal(pids.length, workers);
  const parser = new MacOSDocumentParser([new ImageFormat(vision)]);
  for (const text of [
    'Good morning',
    'صباح الخير',
    'नमस्ते दुनिया',
    '안녕하세요',
    'Доброе утро',
    'สวัสดีครับ',
    '你好世界',
    'こんにちは世界',
  ]) {
    const path = join(directory.path, 'multilingual.png');
    await image(path, text);
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: workers }, () => parser.parse(path)),
      ),
      Array.from({ length: workers }, () => text),
    );
    assert.deepEqual(await workerPids(), pids);
  }
});

test('the parser keeps processing queued images while its other OCR workers are blocked', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-concurrent-'),
  );
  const texts = [
    'Invoice 4821 due Friday',
    'Meet tomorrow',
    'Good morning',
    'See you soon',
    'Have a nice day',
    'Thank you',
  ];
  const paths = texts.map((_, index) => join(directory.path, `${index}.png`));
  for (const [index, path] of paths.entries()) await image(path, texts[index]!);
  await using vision = ocr();
  await vision.ready;
  const parser = new MacOSDocumentParser([new ImageFormat(vision)]);
  const pids = await workerPids();
  assert.equal(pids.length, workers);
  // SIGSTOP holds real native requests; the remaining worker must drain the queue.
  const paused = pids.slice(0, -1);
  const queued = Array.from(
    { length: workers + 1 },
    (_, index) => index % paths.length,
  );
  for (const pid of paused) process.kill(pid, 'SIGSTOP');
  let completed = 0;
  const results = Promise.all(
    queued.map(async (index) => {
      const text = await parser.parse(paths[index]!);
      completed++;
      return text;
    }),
  );
  results.catch(() => undefined);
  try {
    const deadline = Date.now() + 5_000;
    while (completed < queued.length - paused.length && Date.now() < deadline)
      await setTimeout(10);
    assert.equal(
      completed,
      queued.length - paused.length,
      'the available worker must drain the queue while the others are paused',
    );
  } finally {
    for (const pid of paused) process.kill(pid, 'SIGCONT');
    assert.deepEqual(
      await results,
      queued.map((index) => texts[index]),
    );
  }
  assert.deepEqual(await workerPids(), pids);
});

test('aborting an active OCR read leaves the other workers running and skips an aborted queued read', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-abort-'),
  );
  const path = join(directory.path, 'note.png');
  await image(path, 'Meet tomorrow');
  await using vision = ocr();
  await vision.ready;
  const pids = await workerPids();
  assert.equal(pids.length, workers);
  // Three reads hold the three workers before the aborts, so cancellation
  // exercises an active request and a queued request.
  const format = new ImageFormat(vision);
  const active = new AbortController();
  const queued = new AbortController();
  const reason = new Error('Stop this image');
  const cancelled = assert.rejects(
    format.text(path, active.signal),
    (error) => error === reason,
  );
  const others = Array.from({ length: workers - 1 }, () => format.text(path));
  const skipped = assert.rejects(format.text(path, queued.signal), {
    name: 'AbortError',
  });
  const next = format.text(path);
  await inFlight();
  active.abort(reason);
  queued.abort();
  await Promise.all([cancelled, skipped]);
  assert.deepEqual(
    await Promise.all([...others, next]),
    Array.from({ length: workers }, () => 'Meet tomorrow'),
  );
  assert.deepEqual(
    await Promise.all(Array.from({ length: workers }, () => format.text(path))),
    Array.from({ length: workers }, () => 'Meet tomorrow'),
  );
  const recovered = await workerPids();
  assert.equal(recovered.length, workers);
  assert.equal(
    recovered.filter((pid) => pids.includes(pid)).length,
    workers - 1,
  );
});

test('disposing OCR stops all workers and rejects queued reads without starting replacements', async () => {
  await using directory = await mkdtempDisposable(
    join(tmpdir(), 'vision-close-'),
  );
  const path = join(directory.path, 'note.png');
  await image(path, 'Meet tomorrow');
  await using vision = ocr();
  await vision.ready;
  const format = new ImageFormat(vision);
  const requests = workers + 1;
  const reads = Promise.allSettled(
    Array.from({ length: requests }, () => format.text(path)),
  );
  await vision[Symbol.asyncDispose]();
  assert.deepEqual(
    (await reads).map(({ status }) => status),
    Array.from({ length: requests }, () => 'rejected'),
  );
  await assert.rejects(format.text(path), { name: 'AbortError' });
  assert.deepEqual(await workerPids(), []);
});
