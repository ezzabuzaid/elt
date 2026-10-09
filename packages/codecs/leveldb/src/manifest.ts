import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { ByteReader } from './byte-reader.ts';
import { LevelDBFormatError } from './errors.ts';
import { logRecords } from './log.ts';

// The files LevelDB itself would open: CURRENT names the MANIFEST, a log of
// version edits whose replay gives the live tables and the first log still
// to replay. https://github.com/google/leveldb/blob/7ee830d02b623e8ffe0b95d59a74db1e58da04c5/db/version_edit.cc#L121-L185
export type LiveFiles = {
  readonly tables: readonly string[];
  readonly logs: readonly string[];
};

const comparator = 1;
const logNumberTag = 2;
const nextFileNumber = 3;
const lastSequence = 4;
const compactPointer = 5;
const deletedFile = 6;
const newFile = 7;
const prevLogNumberTag = 9;

export async function liveFiles(directory: string): Promise<LiveFiles> {
  const currentPath = join(directory, 'CURRENT');
  const current = await readFile(currentPath, 'utf8');
  if (!current.endsWith('\n') || !/^MANIFEST-\d+$/.test(current.trimEnd()))
    throw new LevelDBFormatError(currentPath, 'it names no MANIFEST');
  const manifestPath = join(directory, current.trimEnd());
  const tables = new Set<number>();
  let logNumber = 0;
  let prevLogNumber = 0;
  for (const edit of logRecords(await readFile(manifestPath), manifestPath)) {
    const reader = new ByteReader(edit, manifestPath);
    while (!reader.done) {
      const tag = reader.varint();
      if (tag === comparator) reader.lengthPrefixed();
      else if (tag === logNumberTag) logNumber = reader.varint();
      else if (tag === prevLogNumberTag) prevLogNumber = reader.varint();
      else if (tag === nextFileNumber || tag === lastSequence) reader.varint();
      else if (tag === compactPointer) {
        reader.varint();
        reader.lengthPrefixed();
      } else if (tag === deletedFile) {
        reader.varint();
        tables.delete(reader.varint());
      } else if (tag === newFile) {
        reader.varint();
        tables.add(reader.varint());
        reader.varint();
        reader.lengthPrefixed();
        reader.lengthPrefixed();
      } else
        throw new LevelDBFormatError(manifestPath, `version edit tag ${tag}`);
    }
  }
  const names = await readdir(directory);
  const numbered = (extension: string) =>
    names.flatMap((name) => {
      const match = new RegExp(`^(\\d+)\\.${extension}$`).exec(name);
      return match?.[1] === undefined
        ? []
        : [[Number(match[1]), name] as const];
    });
  const tableFiles = new Map([...numbered('sst'), ...numbered('ldb')]);
  return {
    tables: [...tables]
      .sort((a, b) => a - b)
      .map((number) => {
        const name = tableFiles.get(number);
        if (name === undefined)
          throw new LevelDBFormatError(
            manifestPath,
            `it lists table ${number}, which is not in ${directory}`,
          );
        return join(directory, name);
      }),
    logs: numbered('log')
      .filter(([number]) => number >= logNumber || number === prevLogNumber)
      .sort(([a], [b]) => a - b)
      .map(([, name]) => join(directory, name)),
  };
}
