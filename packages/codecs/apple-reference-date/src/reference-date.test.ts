import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isWithinDistantDates, referenceDate } from './index.ts';

test('seconds since 2001-01-01 read as a Date rounded to the nearest millisecond', () => {
  assert.deepEqual(
    [0, 812_538_000.0006, 812_538_000.0004, -0.0006].map((seconds) =>
      referenceDate(seconds).toISOString(),
    ),
    [
      '2001-01-01T00:00:00.000Z',
      '2026-10-01T09:00:00.001Z',
      '2026-10-01T09:00:00.000Z',
      '2000-12-31T23:59:59.999Z',
    ],
  );
});

test('NSDate’s distantPast and distantFuture, and anything beyond them, are no real time', () => {
  // timeIntervalSinceReferenceDate of NSDate.distantPast (year 1 in the
  // Julian calendar) and of NSDate.distantFuture, as Foundation reports them.
  const distantPast = -63_114_076_800;
  const distantFuture = 63_113_904_000;

  assert.deepEqual(
    [
      distantPast,
      distantFuture,
      distantPast - 1,
      distantFuture + 1,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.NaN,
    ].map(isWithinDistantDates),
    [false, false, false, false, false, false, false],
  );
  assert.deepEqual(
    [distantPast + 1, 0, distantFuture - 1].map(isWithinDistantDates),
    [true, true, true],
  );
});
