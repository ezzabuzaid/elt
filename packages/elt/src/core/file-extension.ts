import { extname } from 'node:path';

// The extension a file named name keeps when a source stages it or a file
// storage stores it: its own when it is 1 to 16 letters or digits, else none.
// A name from an upstream is untrusted, and one byte past 255 in a file name
// fails the write; a parser still picks a file's format by a short extension.
export function fileExtension(name: string): string {
  const extension = extname(name);
  return /^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension : '';
}
