import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';

import { Modes, Mutex } from '@zukhruf/mutex';
import { SqliteStore } from '@zukhruf/mutex/sqlite';
import { Declaration } from '@zukhruf/sqlite-drift';
import { open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import {
  type CheckpointSession,
  CheckpointStore,
  type FailureType,
} from '@eltjs/elt';

import { busyTimeout } from './open-destination.ts';
import { failureType } from './sqlite-failure-type.ts';

// Each checkpoint's row, and its keyed entries by space (ADR 0035 of elt).
const checkpoints = new Declaration(
  [
    'CREATE TABLE checkpoints (id TEXT PRIMARY KEY NOT NULL, binding TEXT NOT NULL, reloading INTEGER NOT NULL CHECK (reloading IN (0, 1)), state TEXT NOT NULL) STRICT',
    'CREATE TABLE checkpoint_entries (id TEXT NOT NULL, space TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (id, space, key)) STRICT, WITHOUT ROWID',
  ],
  { rows: 'replace' },
);

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
    // The lock never waits (skipIfBusy makes one attempt), and the write of
    // its token retries only a busy file on Windows: real time, as no caller
    // has another correct value.
    this.#locks = new Mutex(
      new SqliteStore(`${this.path}.locks`, { clock: globalThis }),
    );
    Object.freeze(this);
  }

  // The store writes the file, and makes the folder of the locks beside it.
  override failureType(error: unknown): FailureType {
    return failureType(error);
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

  // Each save commits in a transaction of its own, so it is durable when it
  // resolves.
  async #withFile<T>(
    work: (session: CheckpointSession) => Promise<T>,
  ): Promise<T> {
    // Runs of other replications write the same file.
    using database = open(this.path, { timeout: busyTimeout });
    // SQLite gives the -wal and -shm files the mode of the file when it makes
    // them, at the first read after the open.
    chmodSync(this.path, 0o600);
    // A table another version declared otherwise is replaced with its
    // checkpoints, so every replication starts over.
    checkpoints.apply(database);
    return await work({
      read: async (id) => {
        const saved = database
          .prepare('SELECT binding, reloading FROM checkpoints WHERE id = ?')
          .get(id);
        return saved === undefined
          ? undefined
          : {
              binding: String(saved.binding),
              reloading: saved.reloading === 1,
            };
      },
      state: async (id) => {
        const saved = database
          .prepare('SELECT state FROM checkpoints WHERE id = ?')
          .get(id);
        return saved === undefined ? undefined : String(saved.state);
      },
      entries: async (id, space) =>
        database
          .prepare(
            'SELECT key, value FROM checkpoint_entries WHERE id = ? AND space = ?',
          )
          .all(id, space)
          .map(({ key, value }): [string, string] => [
            String(key),
            String(value),
          ]),
      save: async (id, { binding, reloading, state, entries }) => {
        transaction(
          database,
          () => {
            database
              .prepare(
                'INSERT INTO checkpoints (id, binding, reloading, state) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET binding = excluded.binding, reloading = excluded.reloading, state = excluded.state',
              )
              .run(id, binding, reloading ? 1 : 0, state);
            if (entries.kind === 'replace')
              database
                .prepare('DELETE FROM checkpoint_entries WHERE id = ?')
                .run(id);
            else {
              // A scope begins each space it clears, counted in characters
              // as SQLite counts them.
              const clear = database.prepare(
                'DELETE FROM checkpoint_entries WHERE id = ?1 AND substr(space, 1, length(?2)) = ?2',
              );
              for (const scope of entries.clear) clear.run(id, scope);
              const remove = database.prepare(
                'DELETE FROM checkpoint_entries WHERE id = ? AND space = ? AND key = ?',
              );
              for (const { space, key } of entries.remove)
                remove.run(id, space, key);
            }
            const put = database.prepare(
              'INSERT INTO checkpoint_entries (id, space, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(id, space, key) DO UPDATE SET value = excluded.value',
            );
            for (const { space, key, value } of entries.put)
              put.run(id, space, key, value);
          },
          { mode: 'immediate' },
        );
      },
      reloaded: async (id) => {
        database
          .prepare('UPDATE checkpoints SET reloading = 0 WHERE id = ?')
          .run(id);
      },
      remove: async (id) => {
        transaction(
          database,
          () => {
            database
              .prepare('DELETE FROM checkpoint_entries WHERE id = ?')
              .run(id);
            database.prepare('DELETE FROM checkpoints WHERE id = ?').run(id);
          },
          { mode: 'immediate' },
        );
      },
    });
  }
}
