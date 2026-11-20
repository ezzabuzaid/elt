import { createHash } from 'node:crypto';

import type { FileContent } from './file-content.ts';

// The most bytes of one chunk of a file that a destination keeps in its
// database. A chunk is bounded, so no file is held in memory whole, and no
// value of the store is near its largest.
export const storedChunkSize = 4 * 1024 * 1024;

// Writes the bytes of content as a destination keeps a file in its database:
// chunks of at most storedChunkSize bytes, numbered from 0, and one empty
// chunk for an empty file, so the file still has a row that names it. Gives
// the SHA-256 of the bytes, which the row hash of a destination counts in
// place of the id of the file: each load gives a file a new id, so a row
// whose file is the same matches.
export async function writeChunks(
  content: FileContent,
  write: (n: number, bytes: Uint8Array) => Promise<void> | void,
): Promise<Uint8Array> {
  const sha256 = createHash('sha256');
  let n = 0;
  for await (const chunk of content.chunks(storedChunkSize)) {
    sha256.update(chunk);
    await write(n++, chunk);
  }
  if (n === 0) await write(0, new Uint8Array());
  return sha256.digest();
}
