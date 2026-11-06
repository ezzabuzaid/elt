import type { DatabaseSync } from 'node:sqlite';

import { PersistentWriteAheadLog, open } from '@zukhruf/sqlite-open';

// How long a connection waits for the commit of another connection, in
// milliseconds.
export const busyTimeout = 30_000;

// Opens a connection that writes a SQLite file. Agents read the file with
// sqlite3 -readonly from a folder that they cannot write, so the -wal and
// -shm files must stay after the last close. The last connection that writes
// the file and closes decides this, so every such connection opens here.
export function openDestination(path: string): DatabaseSync {
  return open(path, {
    journal: new PersistentWriteAheadLog(),
    timeout: busyTimeout,
  });
}
