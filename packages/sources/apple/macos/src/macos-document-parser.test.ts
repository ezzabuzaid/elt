import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MacOSDocumentParser } from './macos-document-parser.ts';

// A stored file as a storage gives it to identityFor: a name, and a head that
// gives the first bytes that the parser asks for.
function stored(name: string, content: string) {
  return {
    name,
    head: async (length: number) =>
      new TextEncoder().encode(content).subarray(0, length),
  };
}

test('identityFor names the format of a stored file by the extension of its name, or by the magic number in the head that it reads through the storage, and no format for a file that neither names', async () => {
  const parser = new MacOSDocumentParser();

  const identities = {
    pdf: await parser.identityFor(stored('GroupPhotoImage', '%PDF-1.7\n')),
    rtf: await parser.identityFor(stored('pluginPayload', '{\\rtf1 hello}')),
    text: await parser.identityFor(stored('note.TXT', 'plain words')),
    unknown: await parser.identityFor(stored('payload', 'plain words')),
  };

  assert.deepEqual(identities, {
    pdf: 'pdf-v1',
    rtf: 'text-v1',
    text: 'text-v1',
    unknown: null,
  });
});
