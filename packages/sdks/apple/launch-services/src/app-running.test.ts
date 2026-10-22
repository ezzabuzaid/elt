import assert from 'node:assert/strict';
import { test } from 'node:test';

import { appRunning } from './index.ts';

test('an app that runs, as Finder always does while someone is logged in, reads as running', async () => {
  const running = await appRunning('com.apple.finder');

  assert.equal(running, true);
});

test('an app that is not running reads as not running', async () => {
  const running = await appRunning('com.example.no-such-app');

  assert.equal(running, false);
});
