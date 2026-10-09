import { readFile } from 'node:fs/promises';

import { type LevelDBEntry, logEntries } from './log.ts';
import { liveFiles } from './manifest.ts';
import { tableEntries } from './table.ts';

export type LevelDBRecord = {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
};

// Every key a LevelDB database holds, read from its files without opening it:
// the live tables and logs, the write with the highest sequence number
// winning, and a key whose last write deleted it left out. Reads no LOCK and
// writes nothing, so the database's owner may keep it open; files it deletes
// mid-read fail the read with their ENOENT. In no particular order.
export async function readLevelDB(directory: string): Promise<LevelDBRecord[]> {
  const { tables, logs } = await liveFiles(directory);
  const newest = new Map<string, LevelDBEntry>();
  const keep = (entry: LevelDBEntry) => {
    const id = Buffer.from(entry.key).toString('latin1');
    const seen = newest.get(id);
    if (seen === undefined || entry.sequence > seen.sequence)
      newest.set(id, entry);
  };
  for (const path of tables)
    for (const entry of tableEntries(await readFile(path), path)) keep(entry);
  for (const path of logs)
    for (const entry of logEntries(await readFile(path), path)) keep(entry);
  return [...newest.values()].flatMap(({ key, value }) =>
    value === null ? [] : [{ key, value }],
  );
}
