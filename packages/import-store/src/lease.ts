import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The one writer of a store's imports. SQLite releases the lease when its
// connection closes or its process exits. waitMs is how long to wait for a
// holder to let go: leaseHeld() takes the lease for a moment to look, so a
// writer that must not lose to a look waits a little. null when another
// process still holds it, or it cannot be opened now.
export function lease(root: string, waitMs: number): Disposable | null {
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(join(root, 'lease.sqlite'), {
      timeout: waitMs,
    });
    database.exec('BEGIN IMMEDIATE');
    return database;
  } catch {
    database?.close();
    return null;
  }
}

// Whether a writer holds the lease, learned by taking it for a moment without
// waiting.
export function leaseHeld(root: string): boolean {
  const held = lease(root, 0);
  held?.[Symbol.dispose]();
  return held === null;
}
