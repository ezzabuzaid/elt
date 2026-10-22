import { open } from 'node:fs/promises';

const length = 4100;

// A file's leading bytes, where most formats name themselves. A file shorter
// than the head holds only the bytes it has.
export class FileHead {
  readonly bytes: Uint8Array;
  readonly ascii: string;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.ascii = new TextDecoder('latin1').decode(bytes);
  }

  static async read(path: string): Promise<FileHead> {
    await using file = await open(path);
    const bytes = new Uint8Array(length);
    const { bytesRead } = await file.read(bytes, 0, length, 0);
    return new FileHead(bytes.subarray(0, bytesRead));
  }

  startsWith(...bytes: number[]): boolean {
    return bytes.every((byte, index) => this.bytes[index] === byte);
  }
}
