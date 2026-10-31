import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { readPlist } from './index.ts';

test('a property list larger than a mebibyte reads whole', async () => {
  await using scratch = await new TemporaryFiles().directory('codec-plist-');
  const path = join(scratch.path, 'large.plist');
  const note = 'x'.repeat(2 * 1024 * 1024);
  await writeFile(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>note</key><string>${note}</string></dict></plist>`,
  );

  const value = await readPlist(path);

  assert.deepEqual(value, { note });
});
