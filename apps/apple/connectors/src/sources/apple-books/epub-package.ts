import { open } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

import {
  type LocalFile,
  compareByName,
} from '../../platform/macos/icloud-files.ts';

// Books keeps an EPUB as its unzipped package directory. This writes the
// single-file form every reader opens: a ZIP whose first entry is the
// uncompressed mimetype (EPUB OCF), every entry stored, in name order, with a
// fixed timestamp, so the same package always yields the same bytes.

const chunkSize = 4 * 1024 * 1024;
// 1980-01-01 00:00, the earliest MS-DOS date.
const dosTime = 0;
const dosDate = (0 << 9) | (1 << 5) | 1;
// General purpose flag bit 11: names are UTF-8.
const utf8Names = 0x0800;

type Entry = { readonly name: Buffer; readonly file: LocalFile; crc: number };

async function checksum(path: string): Promise<number> {
  await using file = await open(path);
  let value = 0;
  const buffer = Buffer.allocUnsafe(chunkSize);
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, chunkSize, null);
    if (bytesRead === 0) return value;
    value = crc32(buffer.subarray(0, bytesRead), value);
  }
}

function localHeader({ name, file, crc }: Entry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(utf8Names, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(dosTime, 10);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(file.size, 18);
  header.writeUInt32LE(file.size, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader({ name, file, crc }: Entry, offset: number): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(utf8Names, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(dosTime, 12);
  header.writeUInt16LE(dosDate, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(file.size, 20);
  header.writeUInt32LE(file.size, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

// Writes the package's files as one .epub at target. Throws when the package
// has no mimetype file or exceeds what a ZIP without ZIP64 holds.
export async function writeEpub(
  files: readonly LocalFile[],
  target: string,
): Promise<void> {
  const mimetype = files.find((file) => file.name === 'mimetype');
  if (mimetype === undefined)
    throw new TypeError('EPUB package has no mimetype file');
  const ordered = [
    mimetype,
    ...files.filter((file) => file !== mimetype).sort(compareByName),
  ];
  if (ordered.length > 0xffff)
    throw new RangeError('EPUB package has too many files for a ZIP');
  const entries: Entry[] = [];
  for (const file of ordered)
    entries.push({
      name: Buffer.from(file.name, 'utf8'),
      file,
      crc: await checksum(file.path),
    });
  await using output = await open(target, 'wx', 0o600);
  let offset = 0;
  const write = async (bytes: Buffer) => {
    await output.write(bytes);
    offset += bytes.length;
  };
  const written: { entry: Entry; offset: number }[] = [];
  const buffer = Buffer.allocUnsafe(chunkSize);
  for (const entry of entries) {
    written.push({ entry, offset });
    await write(localHeader(entry));
    await using input = await open(entry.file.path);
    let remaining = entry.file.size;
    while (remaining > 0) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(chunkSize, remaining),
        null,
      );
      if (bytesRead === 0)
        throw new Error(`${entry.file.path} shrank while it was packaged`);
      await write(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
    }
    if (offset > 0xffffffff)
      throw new RangeError('EPUB package exceeds 4 GiB without ZIP64');
  }
  const directoryStart = offset;
  for (const { entry, offset: start } of written)
    await write(centralHeader(entry, start));
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  await write(end);
  await output.sync();
}
