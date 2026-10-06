import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// SF_DATALESS: an iCloud Drive placeholder whose bytes are not on this Mac.
// Reading it, or listing it when it is a directory, makes macOS download it.
const dataless = 0x40000000;

// Node's stat has no BSD file flags, so /usr/bin/stat reads them, many paths
// per call. Missing paths are left out of the result.
async function flags(paths: readonly string[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (let start = 0; start < paths.length; start += 256) {
    const batch = paths.slice(start, start + 256);
    const { stdout } = await run('/usr/bin/stat', ['-f', '%Xf %N', ...batch], {
      maxBuffer: 16 * 1024 * 1024,
    }).catch((error: { stdout?: string }) => {
      // stat exits non-zero when any path is missing but still prints the rest.
      if (typeof error.stdout === 'string') return { stdout: error.stdout };
      throw error;
    });
    for (const line of stdout.split('\n')) {
      const space = line.indexOf(' ');
      if (space > 0)
        found.set(
          line.slice(space + 1),
          Number.parseInt(line.slice(0, space), 16),
        );
    }
  }
  return found;
}

// Which of these paths exist with their bytes on this Mac, read from their
// flags alone so no placeholder is fetched.
async function localPaths(paths: readonly string[]): Promise<Set<string>> {
  const found = await flags(paths);
  return new Set(
    paths.filter((path) => {
      const value = found.get(path);
      return value !== undefined && (value & dataless) === 0;
    }),
  );
}

export type LocalFile = {
  // Path relative to the item, with forward slashes.
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedMs: number;
};

// Code-unit order, so the same package always lists in the same order.
export function compareByName(a: LocalFile, b: LocalFile): number {
  if (a.name < b.name) return -1;
  if (a.name > b.name) return 1;
  return 0;
}

// Every regular file of a local item: the item itself when it is a file, or
// each file inside a package directory such as an .epub. Returns null when the
// item or anything inside it is a placeholder; directories are listed only
// after their own flags show they are local.
export async function localFiles(item: string): Promise<LocalFile[] | null> {
  if (!(await localPaths([item])).has(item)) return null;
  const info = await lstat(item);
  if (info.isFile())
    return [
      {
        name: '',
        path: item,
        size: info.size,
        modifiedMs: info.mtimeMs,
      },
    ];
  if (!info.isDirectory()) return null;
  const files: LocalFile[] = [];
  const pending = [''];
  for (
    let relative = pending.pop();
    relative !== undefined;
    relative = pending.pop()
  ) {
    const directory = join(item, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    const listed = entries.map((entry) => ({
      entry,
      path: join(directory, entry.name),
    }));
    const local = await localPaths(listed.map(({ path }) => path));
    for (const { entry, path } of listed) {
      if (!local.has(path)) return null;
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(name);
      else if (entry.isFile()) {
        const { size, mtimeMs } = await lstat(path);
        files.push({ name, path, size, modifiedMs: mtimeMs });
      }
    }
  }
  return files.sort(compareByName);
}
