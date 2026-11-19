import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/fs';

import { MacOSDocumentParser } from './macos-document-parser.ts';

test('a PDF that PDFKit cannot read fails with the reason that PDFKit gives, not the osascript command or the path of the file', async () => {
  await using scratch = await new TemporaryFiles().directory('macos-pdf-');
  const path = join(scratch.path, 'scan.pdf');
  await writeFile(path, '%PDF-1.7\nthe rest of this file is not a PDF\n');

  const error = await new MacOSDocumentParser().parse(path).then(
    () => assert.fail('the parse reported no failure'),
    (error: unknown) => error,
  );

  assert.ok(Error.isError(error), String(error));
  assert.equal(error.message, 'Cannot read PDF (-2700)');
});
