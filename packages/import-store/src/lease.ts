import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The one writer of a store's imports. SQLite releases the lease when its
// connection closes or its process exits. null when another process holds it,
// or it cannot be opened now.
export function lease(root: string): Disposable | null {
  let database: DatabaseSync | undefined;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    database = new DatabaseSync(join(root, 'lease.sqlite'));
    database.exec('BEGIN IMMEDIATE');
    return database;
  } catch {
    database?.close();
    return null;
  }
}

export function leaseHeld(root: string): boolean {
  const held = lease(root);
  held?.[Symbol.dispose]();
  return held === null;
}
