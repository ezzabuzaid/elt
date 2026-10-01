import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ImportStore, NewerLayoutError } from 'import-store';

// Codex keeps one plugin server per chat and stops none of them on an upgrade,
// so each server records its version here, and the newest leads. This file is
// apart from the lease, which the leader keeps locked, and from the settings,
// which a new store layout empties.
function servers(root: string): DatabaseSync {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(join(root, 'servers.sqlite'));
  database.exec(
    'CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, version TEXT NOT NULL, seen_at INTEGER NOT NULL)',
  );
  return database;
}

const newer = (candidate: string, version: string) => {
  const [left, right] = [candidate, version].map((value) =>
    value.split('.').map(Number),
  );
  for (let part = 0; part < 3; part++)
    if (left?.[part] !== right?.[part])
      return (left?.[part] ?? 0) > (right?.[part] ?? 0);
  return false;
};

// Whether a newer layout owns the store, or a newer plugin server is running,
// after recording this server as running. A server that stopped cleanly
// removed itself; one that crashed stops counting once its heartbeat is ten
// seconds old, and is forgotten after an hour.
export function outdated(root: string, id: string, version: string): boolean {
  try {
    using _store = new ImportStore(root);
  } catch (error) {
    if (error instanceof NewerLayoutError) return true;
  }
  try {
    using database = servers(root);
    const now = Date.now();
    database
      .prepare(
        'INSERT INTO servers VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, seen_at=excluded.seen_at',
      )
      .run(id, version, now);
    database
      .prepare('DELETE FROM servers WHERE seen_at < ?')
      .run(now - 3_600_000);
    return database
      .prepare('SELECT version FROM servers WHERE seen_at >= ?')
      .all(now - 10_000)
      .some((row) => newer(String(row.version), version));
  } catch {
    return false;
  }
}

export function forgetServer(root: string, id: string) {
  using database = servers(root);
  database.prepare('DELETE FROM servers WHERE id=?').run(id);
}
