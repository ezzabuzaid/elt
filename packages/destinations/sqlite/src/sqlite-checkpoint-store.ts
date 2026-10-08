import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Modes, Mutex, SqliteStore } from '@zukhruf/mutex';

import { type CheckpointSession, CheckpointStore } from '@workspace/elt';

export class SQLiteCheckpointStore extends CheckpointStore {
  readonly path: string;
  // One key per replication, in a folder beside the state file. The kernel
  // releases a key when the run holding it exits.
  readonly #locks: Mutex;

  constructor({ path }: { path: string }) {
    super();
    if (!path || path === ':memory:' || path.includes('\0'))
      throw new TypeError('Checkpoints require a persistent SQLite file');
    this.path = resolve(path);
    this.#locks = new Mutex(new SqliteStore(`${this.path}.locks`));
    Object.freeze(this);
  }

  // Holds each replication's key in turn, then works. A replication already
  // running fails the run fast; others run in parallel.
  protected override async session<T>(
    ids: readonly string[],
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    const [id, ...rest] = ids;
    if (id === undefined) return this.#withFile(work);
    const held = await this.#locks.acquire(id, () => this.session(rest, work), {
      mode: Modes.skipIfBusy(),
    });
    if (!held.acquired)
      throw new TypeError(`Checkpoint ${id} is in use by another run`);
    return held.value;
  }

  // Each save commits on its own, so it is durable when it resolves.
  async #withFile<T>(
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    // Runs of other replications write the same file.
    using database = new DatabaseSync(this.path, { timeout: 30_000 });
    chmodSync(this.path, 0o600);
    database.exec(
      'CREATE TABLE IF NOT EXISTS checkpoints (id TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, state TEXT NOT NULL) STRICT',
    );
    return await work({
      read: async (id) => {
        const saved = database
          .prepare('SELECT binding, state FROM checkpoints WHERE id = ?')
          .get(id);
        return saved === undefined
          ? undefined
          : { binding: String(saved.binding), state: String(saved.state) };
      },
      save: async (id, { binding, state }) => {
        database
          .prepare(
            'INSERT INTO checkpoints (id, binding, state) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET binding = excluded.binding, state = excluded.state',
          )
          .run(id, binding, state);
      },
      remove: async (id) => {
        database.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
      },
    });
  }
}
