import { open } from 'node:fs/promises';

// A staged file's bytes, read in bounded chunks so no file is ever held in
// memory whole. Valid until the consumer advances past the record carrying it.
export class FileContent {
  constructor(readonly path: string) {
    Object.freeze(this);
  }

  async *chunks(size: number): AsyncGenerator<Uint8Array> {
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new TypeError('Chunk size must be a positive integer');
    await using file = await open(this.path);
    let remaining = (await file.stat()).size;
    while (remaining > 0) {
      const chunk = new Uint8Array(Math.min(size, remaining));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0)
        throw new Error(`File ${this.path} shrank while it was read`);
      remaining -= bytesRead;
      yield chunk.subarray(0, bytesRead);
    }
  }
}
