import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';
import { type Clock, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import {
  DisposedError,
  Fixed,
  LeaderFirst,
  NoEviction,
  Pool,
  PoolWorkers,
} from '@zukhruf/pool';
import { waitFor } from '@zukhruf/testing/async';

import { ImageFormat } from './document-formats/image-format.ts';
import { MacOSDocumentParser } from './macos-document-parser.ts';
import { visionKind } from './vision-kind.ts';
import { VisionWorker } from './vision.ts';

const execute = promisify(execFile);
const workers = 3;
const helper = fileURLToPath(
  import.meta.resolve('@eltjs/source-apple-macos/vision-worker'),
);

// Vision reads no text in a virtual Mac: in the macOS virtual machine of
// GitHub's runners every OCR warm-up failed with "IOServiceMatchingfailed for:
// AppleM2ScalerParavirtDriver" (CI run 44391479307). A test that reads text
// through Vision runs on a Mac that is not a virtual machine.
const textRecognition = {
  skip:
    execFileSync('/usr/sbin/sysctl', ['-n', 'kern.hv_vmm_present'], {
      encoding: 'utf8',
    }).trim() === '1' && 'Vision reads no text in a virtual Mac',
};

// The Pool that sends the reads and the PoolWorkers that offer the Vision
// workers, as a host builds them, sized to three workers on every Mac, on a
// store of the test's own. The pool runs on the real clock; the workers time
// their warm-up and their reads on `clock`.
async function ocr(clock: Clock = globalThis) {
  const folder = await new TemporaryFiles().directory('vision-store-');
  const store = join(folder.path, 'store.sqlite');
  const offered = new PoolWorkers({
    kind: visionKind,
    store,
    clock: globalThis,
    size: new Fixed(workers),
    startup: new LeaderFirst(),
    eviction: new NoEviction(),
    create: () => new VisionWorker(helper, clock),
  });
  const pool = new Pool({ kind: visionKind, store, clock: globalThis });
  let closed: Promise<void> | undefined;
  const close = async () => {
    try {
      await pool[Symbol.asyncDispose]();
      await offered[Symbol.asyncDispose]();
    } finally {
      await folder[Symbol.asyncDispose]();
    }
  };
  return {
    pool,
    ready: () => offered.ready(),
    get stats() {
      return offered.stats;
    },
    [Symbol.asyncDispose]: () => (closed ??= close()),
  };
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

// The owner starts its leader once it won the election of its store, and
// starts no other worker while the leader warms up.
async function leaderPid(signal: AbortSignal): Promise<number> {
  const [leader] = await waitFor(
    async () => {
      const pids = await workerPids();
      assert.equal(pids.length, 1, 'only the first worker may start');
      return pids;
    },
    { signal, interval: 10 },
  );
  return leader!;
}

// Identical reads share one job, so a test that needs one read on each worker
// reads copies of one image.
async function copies(path: string, count: number): Promise<string[]> {
  return Array.fromAsync({ length: count }, async (_, index) => {
    const copy = path.replace(/(\.\w+)$/, `-${index}$1`);
    await copyFile(path, copy);
    return copy;
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

test(
  'the warmed parser preserves OCR, concurrent responses and image errors, and runs the read of a killed worker again on another one',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-parser-',
    );
    const receipt = join(directory.path, 'receipt.thumb');
    const note = join(directory.path, 'note.png');
    const blank = join(directory.path, 'blank.png');
    const corrupt = join(directory.path, 'corrupt.png');
    await image(receipt, 'Invoice 4821 due Friday');
    await image(note, 'Meet tomorrow');
    await image(blank, '');
    await writeFile(corrupt, 'not an image');
    await using vision = await ocr();
    await vision.ready();
    const pids = await workerPids();
    assert.equal(pids.length, workers);
    const parser = new MacOSDocumentParser([new ImageFormat(vision.pool)]);
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
    await assert.rejects(parser.parse(note, stop.signal), {
      name: 'AbortError',
    });
    // One read for each worker, so the killed worker has one in flight. The
    // kind runs a failed read once more, so the read of the killed worker
    // comes back from another worker.
    const pid = pids[0]!;
    const format = new ImageFormat(vision.pool);
    const reads = (await copies(receipt, workers)).map((copy) =>
      format.text(copy),
    );
    await waitFor(() => assert.equal(vision.stats.lent, workers), {
      signal: t.signal,
      interval: 5,
    });
    process.kill(pid, 'SIGKILL');
    assert.deepEqual(
      await Promise.all(reads),
      Array.from({ length: workers }, () => 'Invoice 4821 due Friday'),
    );
    assert.deepEqual(
      await Promise.all([parser.parse(receipt), parser.parse(note)]),
      ['Invoice 4821 due Friday', 'Meet tomorrow'],
    );
    // The eager pool replaces the killed worker after its back-off (1 s
    // after an early exit).
    await waitFor(
      async () => assert.equal((await workerPids()).length, workers),
      { signal: t.signal, interval: 100 },
    );
    const recovered = await workerPids();
    assert.equal(recovered.length, workers);
    assert.ok(!recovered.includes(pid));
    assert.ok(pids.slice(1).every((pid) => recovered.includes(pid)));
  },
);

test(
  'the first worker warms up alone and the others start together once it is ready',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-startup-order-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    await using vision = await ocr();
    const leader = await leaderPid(t.signal);
    // A stopped leader models slow native compilation without clearing Apple's
    // shared cache. No other worker may race that compilation.
    process.kill(leader, 'SIGSTOP');
    const parser = new MacOSDocumentParser([new ImageFormat(vision.pool)]);
    const reads = Promise.all(
      (await copies(path, workers)).map((copy) => parser.parse(copy)),
    );
    reads.catch(() => undefined);
    try {
      await setTimeout(3_000);
      assert.deepEqual(await workerPids(), [leader]);
    } finally {
      process.kill(leader, 'SIGCONT');
    }
    await vision.ready();
    const pids = await workerPids();
    assert.equal(pids.length, workers);
    assert.ok(pids.includes(leader));
    assert.deepEqual(
      await reads,
      Array.from({ length: workers }, () => 'Meet tomorrow'),
    );
    assert.deepEqual(await workerPids(), pids);
  },
);

test(
  'cancelling a read while the first worker warms up keeps that warm-up for later reads',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-startup-cancel-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    await using vision = await ocr();
    const leader = await leaderPid(t.signal);
    process.kill(leader, 'SIGSTOP');
    const format = new ImageFormat(vision.pool);
    const stop = new AbortController();
    try {
      const cancelled = assert.rejects(format.text(path, stop.signal), {
        name: 'AbortError',
      });
      stop.abort();
      await cancelled;
    } finally {
      process.kill(leader, 'SIGCONT');
    }
    await vision.ready();
    assert.ok((await workerPids()).includes(leader));
    assert.equal(await format.text(path), 'Meet tomorrow');
  },
);

test(
  'the parser waits for slow OCR warm-up beyond the image deadline and reuses its workers',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-cold-start-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    // Apple's shared compiler cache cannot be reset in a test. Hold the leader
    // before readiness and advance only the workers' clock through the cold
    // start, stopping just short of the 10-minute warm-up deadline.
    const clock = createClock();
    await using vision = await ocr(clock);
    const ready = vision.ready();
    let warmed = false;
    ready.then(
      () => {
        warmed = true;
      },
      () => undefined,
    );
    const leader = await leaderPid(t.signal);
    process.kill(leader, 'SIGSTOP');
    try {
      assert.equal(warmed, false, 'the leader must still be warming up');
      clock.tick(599_999);
    } finally {
      process.kill(leader, 'SIGCONT');
    }
    await ready;
    // A ready worker keeps no warm-up deadline: ten more minutes kill none.
    clock.tick(600_001);
    const pids = await workerPids();
    assert.equal(pids.length, workers);
    assert.ok(pids.includes(leader));
    const parser = new MacOSDocumentParser([new ImageFormat(vision.pool)]);
    assert.equal(await parser.parse(path), 'Meet tomorrow');
    assert.deepEqual(await workerPids(), pids);
  },
);

test(
  'a warm-up that does not finish in ten minutes is killed, the read waiting for it runs again on a new worker, and the pool starts every worker',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-warm-up-deadline-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    const clock = createClock();
    await using vision = await ocr(clock);
    const leader = await leaderPid(t.signal);
    process.kill(leader, 'SIGSTOP');
    const format = new ImageFormat(vision.pool);
    const read = format.text(path);
    try {
      await waitFor(() => assert.equal(vision.stats.waiting, 1), {
        signal: t.signal,
        interval: 5,
      });
      clock.tick(600_001);
    } finally {
      process.kill(leader, 'SIGCONT');
    }
    assert.equal(await read, 'Meet tomorrow');
    await waitFor(
      async () => {
        const pids = await workerPids();
        assert.equal(pids.length, workers);
        assert.ok(!pids.includes(leader));
      },
      { signal: t.signal, interval: 100 },
    );
  },
);

test(
  'an image still times out after warm-up, its read runs again on another worker, and the pool replaces the killed one',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-timeout-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    const clock = createClock();
    await using vision = await ocr(clock);
    await vision.ready();
    const pids = await workerPids();
    const format = new ImageFormat(vision.pool);
    for (const pid of pids) process.kill(pid, 'SIGSTOP');
    const read = format.text(path);
    try {
      // Let a ready worker start the read before advancing its deadline.
      await waitFor(() => assert.equal(vision.stats.lent, 1), {
        signal: t.signal,
        interval: 5,
      });
      clock.tick(120_001);
    } finally {
      for (const pid of pids) process.kill(pid, 'SIGCONT');
    }
    assert.equal(await read, 'Meet tomorrow');
    // The eager pool replaces the killed worker after its back-off (1 s
    // after an early exit).
    await waitFor(
      async () => assert.equal((await workerPids()).length, pids.length),
      { signal: t.signal, interval: 100 },
    );
    const recovered = await workerPids();
    assert.equal(recovered.length, pids.length);
    assert.equal(
      recovered.filter((pid) => pids.includes(pid)).length,
      pids.length - 1,
    );
  },
);

test('disposing OCR during warm-up rejects readiness and stops every worker', async (t) => {
  await using vision = await ocr();
  await leaderPid(t.signal);
  const ready = assert.rejects(vision.ready());
  await vision[Symbol.asyncDispose]();
  await ready;
  assert.deepEqual(await workerPids(), []);
});

void test.each(
  [
    'Good morning',
    'صباح الخير',
    'नमस्ते दुनिया',
    '안녕하세요',
    'Доброе утро',
    'สวัสดีครับ',
    '你好世界',
    'こんにちは世界',
  ],
  (text) =>
    test(
      `the ready parser preserves the automatically detected text ${text} in all reused workers`,
      textRecognition,
      async () => {
        await using directory = await new TemporaryFiles().directory(
          'vision-languages-',
        );
        await using vision = await ocr();
        await vision.ready();
        const pids = await workerPids();
        assert.equal(pids.length, workers);
        const parser = new MacOSDocumentParser([new ImageFormat(vision.pool)]);
        const path = join(directory.path, 'multilingual.png');
        await image(path, text);
        assert.deepEqual(
          await Promise.all(
            (await copies(path, workers)).map((copy) => parser.parse(copy)),
          ),
          Array.from({ length: workers }, () => text),
        );
        assert.deepEqual(await workerPids(), pids);
      },
    ),
);

test(
  'the parser keeps processing queued images while its other OCR workers are blocked',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-concurrent-',
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
    for (const [index, path] of paths.entries())
      await image(path, texts[index]!);
    await using vision = await ocr();
    await vision.ready();
    const parser = new MacOSDocumentParser([new ImageFormat(vision.pool)]);
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
      await waitFor(
        () => {
          assert.equal(
            completed,
            queued.length - paused.length,
            'the available worker must drain the queue while the others are paused',
          );
        },
        { signal: t.signal, interval: 10 },
      );
    } finally {
      for (const pid of paused) process.kill(pid, 'SIGCONT');
      assert.deepEqual(
        await results,
        queued.map((index) => texts[index]),
      );
    }
    assert.deepEqual(await workerPids(), pids);
  },
);

test(
  'aborting a read rejects it with the reason and an aborted queued read with an AbortError, while their jobs run on and every worker keeps running',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-abort-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    await using vision = await ocr();
    await vision.ready();
    const pids = await workerPids();
    assert.equal(pids.length, workers);
    // Three reads hold the three workers before the aborts, so cancellation
    // meets an active request and a queued one. Identical reads share one
    // job, so a cancel is a leave: the job runs on for the other callers,
    // and its worker is not killed.
    const [first, ...rest] = await copies(path, workers + 2);
    const format = new ImageFormat(vision.pool);
    const active = new AbortController();
    const queued = new AbortController();
    const reason = new Error('Stop this image');
    const cancelled = assert.rejects(
      format.text(first!, active.signal),
      (error) => error === reason,
    );
    const others = rest.slice(0, workers - 1).map((copy) => format.text(copy));
    await waitFor(() => assert.equal(vision.stats.lent, workers), {
      signal: t.signal,
      interval: 5,
    });
    const skipped = assert.rejects(format.text(rest.at(-2)!, queued.signal), {
      name: 'AbortError',
    });
    const next = format.text(rest.at(-1)!);
    active.abort(reason);
    queued.abort();
    await Promise.all([cancelled, skipped]);
    assert.deepEqual(
      await Promise.all([...others, next]),
      Array.from({ length: workers }, () => 'Meet tomorrow'),
    );
    assert.deepEqual(await workerPids(), pids);
  },
);

test(
  'disposing OCR stops all workers and rejects queued reads without starting replacements',
  textRecognition,
  async () => {
    await using directory = await new TemporaryFiles().directory(
      'vision-close-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    await using vision = await ocr();
    await vision.ready();
    const format = new ImageFormat(vision.pool);
    const requests = workers + 1;
    const reads = Promise.allSettled(
      (await copies(path, requests)).map((copy) => format.text(copy)),
    );
    await vision[Symbol.asyncDispose]();
    assert.deepEqual(
      (await reads).map(({ status }) => status),
      Array.from({ length: requests }, () => 'rejected'),
    );
    await assert.rejects(format.text(path), DisposedError);
    assert.deepEqual(await workerPids(), []);
  },
);

test(
  'a worker exits when its parent dies by SIGKILL, even with its main thread blocked',
  textRecognition,
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'vision-orphan-',
    );
    const stdin = join(directory.path, 'stdin');
    await execute('/usr/bin/mkfifo', [stdin]);
    // This test keeps the worker's stdin open past the parent's death, so the
    // main thread stays in a blocking read, as it stays in a compile that hangs
    // (#3067), and no end of stdin can stop the worker. A healthy warm-up cannot
    // show this: its ready line hits the closed stdout and ends the worker
    // anyway.
    await using held = await open(stdin, constants.O_RDWR);
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const worker = require('node:child_process').spawn(process.argv[1], [], { stdio: ['inherit', 'pipe', 'ignore'] });
       console.log(String(worker.pid));
       worker.stdout.pipe(process.stdout);`,
        helper,
      ],
      { stdio: [held.fd, 'pipe', 'inherit'] },
    );
    const lines = createInterface({ input: parent.stdout! })[
      Symbol.asyncIterator
    ]();
    const worker = Number((await lines.next()).value);
    try {
      // The ready line puts the main thread in that read. A warm-up that hangs
      // never says it, and the test fails at its limit.
      await untilAborted(lines.next(), t.signal);
      // A warm-up that failed already ended the worker, which would prove nothing.
      process.kill(worker, 0);
      parent.kill('SIGKILL');
      await waitFor(
        () => assert.throws(() => process.kill(worker, 0), { code: 'ESRCH' }),
        { signal: t.signal, interval: 100 },
      );
    } catch (error) {
      process.kill(worker, 'SIGKILL');
      throw error;
    } finally {
      parent.kill('SIGKILL');
    }
  },
);

test(
  'a parent that closes stdin with a read in flight gets its answer, and the worker exits 0',
  textRecognition,
  async () => {
    await using directory = await new TemporaryFiles().directory(
      'vision-clean-close-',
    );
    const path = join(directory.path, 'note.png');
    await image(path, 'Meet tomorrow');
    const worker = new VisionWorker(helper, globalThis);
    try {
      await worker.ready();
      const reading = worker.run({ path });
      await worker.close();
      assert.deepEqual(await reading, { text: 'Meet tomorrow' });
      assert.match((await worker.exited()).message, /exited \(0\)/);
    } finally {
      worker.kill();
    }
  },
);
