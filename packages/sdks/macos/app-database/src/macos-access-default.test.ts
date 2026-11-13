import assert from 'node:assert/strict';
import { test } from 'node:test';

import { macOSAccess } from './index.ts';

// No test in this file installs a program, as a plain script that uses an SDK
// installs none.
test('with no program installed, a remedy names the program generically', () => {
  assert.equal(
    macOSAccess.remedy('calendars'),
    'Turn on the program that runs this process in System Settings › Privacy & Security › Calendars.',
  );
});
