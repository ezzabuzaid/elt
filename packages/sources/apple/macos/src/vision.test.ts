import assert from 'node:assert/strict';
import { test } from 'node:test';

import { visionConcurrency } from './vision.ts';

test('OCR concurrency fits both available CPUs and memory, keeping one worker under pressure', () => {
  for (const [cpus, gib, expected] of [
    [1, 16, 1],
    [2, 16, 2],
    [8, 2, 1],
    [8, 3.9, 1],
    [14, 5, 2],
    [14, 10, 5],
    [14, 12.5, 6],
    [14, 48, 14],
    [24, 64, 24],
    [8, 0.5, 1],
    [8, 0, 1],
  ] as const) {
    assert.equal(
      visionConcurrency(cpus, gib * 1024 ** 3),
      expected,
      `${cpus} CPUs, ${gib} GiB available`,
    );
  }
});
