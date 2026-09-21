import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { CommittedWriteError, type WriteResult } from '../core/writer.ts';

// Checkpoints belong to a replication ID, not to a shared Stream or warehouse table.
export class SQLiteCheckpointStore {
  readonly path: string;

  constructor({ path }: { path: string }) {
    if (!path || path === ':memory:' || path.includes('\0'))
      throw new TypeError('Checkpoints require a persistent SQLite file');
    this.path = resolve(path);
    Object.freeze(this);
  }

  async run(
    id: string,
    binding: object,
    write: (state: unknown) => Promise<WriteResult>,
  ): Promise<number> {
    let committed: number | undefined;
    try {
      const serializedBinding = JSON.stringify(binding);
      using database = this.open();
      // ponytail: one state file serializes copies; use separate files if parallel replication is required.
      // Native locks release on process exit. Contention fails without blocking the JS event loop.
      database.exec('BEGIN IMMEDIATE');
      try {
        const saved = database
          .prepare('SELECT binding, state FROM checkpoints WHERE id = ?')
          .get(id);
        if (
          saved !== undefined &&
          (typeof saved.binding !== 'string' ||
            !isDeepStrictEqual(
              JSON.parse(saved.binding),
              JSON.parse(serializedBinding),
            ))
        )
          throw new TypeError(
            `Checkpoint binding changed for ${id}; reset it or use a new copy ID`,
          );
        const state: unknown =
          saved === undefined ? null : JSON.parse(String(saved.state));
        // A source may mutate its input state, but only an acknowledged message may advance it.
        const result = await write(structuredClone(state));
        committed = result.count;
        const last = result.checkpoints.at(-1);
        database
          .prepare(
            'INSERT INTO checkpoints (id, binding, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state',
          )
          .run(
            id,
            serializedBinding,
            JSON.stringify(last === undefined ? state : last.state),
          );
        database.exec('COMMIT');
        return result.count;
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK');
        throw error;
      }
    } catch (cause) {
      if (committed !== undefined)
        throw new CommittedWriteError(
          committed,
          'Destination committed, but checkpoint persistence failed; retry may replay records',
          cause,
        );
      throw cause;
    }
  }

  reset(id: string): void {
    using database = this.open();
    database.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
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
