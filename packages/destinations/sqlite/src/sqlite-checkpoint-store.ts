import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type CheckpointSession, CheckpointStore } from 'elt';

export class SQLiteCheckpointStore extends CheckpointStore {
  readonly path: string;

  constructor({ path }: { path: string }) {
    super();
    if (!path || path === ':memory:' || path.includes('\0'))
      throw new TypeError('Checkpoints require a persistent SQLite file');
    this.path = resolve(path);
    Object.freeze(this);
  }

  override async reset(id: string): Promise<void> {
    using database = this.open();
    database.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
  }

  protected override async session<T>(
    id: string,
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    using database = this.open();
    // ponytail: one state file serializes copies; use separate files if parallel replication is required.
    // Native locks release on process exit. Contention fails without blocking the JS event loop.
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = await work({
        read: async () => {
          const saved = database
            .prepare('SELECT binding, state FROM checkpoints WHERE id = ?')
            .get(id);
          return saved === undefined
            ? undefined
            : { binding: String(saved.binding), state: String(saved.state) };
        },
        save: async ({ binding, state }) => {
          database
            .prepare(
              'INSERT INTO checkpoints (id, binding, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
            )
            .run(id, binding, state);
        },
      });
      database.exec('COMMIT');
      return result;
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK');
      throw error;
    }
  }

  private open(): DatabaseSync {
    const database = new DatabaseSync(this.path);
    try {
      chmodSync(this.path, 0o600);
      database.exec(
        'CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL) STRICT',
      );
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }
}
