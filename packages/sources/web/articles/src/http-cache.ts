import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { Keyv } from 'keyv';
import { z } from 'zod';

const metadata = z.object({
  value: z.object({
    url: z.string(),
    statusCode: z.number().int(),
    cachePolicy: z.record(z.string(), z.unknown()),
  }),
  expires: z.number().optional(),
});
const storedRow = z
  .object({ value: z.string(), body: z.instanceof(Uint8Array) })
  .optional();
const bodyEntry = z.object({
  value: z.object({ body: z.instanceof(Buffer) }),
});

export class HTTPCache extends Keyv<unknown> implements AsyncDisposable {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    using resources = new DisposableStack();
    const database = resources.use(new DatabaseSync(path, { timeout: 30_000 }));
    chmodSync(path, 0o600);
    database.exec(
      `CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
       CREATE TABLE IF NOT EXISTS cache_bodies (
         key TEXT PRIMARY KEY REFERENCES cache(key) ON DELETE CASCADE,
         body BLOB NOT NULL
       ) STRICT`,
    );
    super({
      namespace: 'cacheable-request',
      throwOnErrors: true,
      serialize: undefined,
      deserialize: undefined,
      store: {
        get(key: string) {
          const row = storedRow.parse(
            database
              .prepare(
                'SELECT value, body FROM cache JOIN cache_bodies USING (key) WHERE key = ?',
              )
              .get(key),
          );
          if (row === undefined) return undefined;
          const entry = metadata.parse(JSON.parse(row.value));
          return {
            ...entry,
            value: { ...entry.value, body: Buffer.from(row.body) },
          };
        },
        set(key: string, value: unknown) {
          const entry = metadata.parse(value);
          const {
            value: { body },
          } = bodyEntry.parse(value);
          database.exec('BEGIN');
          try {
            database
              .prepare(
                'INSERT INTO cache VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
              )
              .run(key, JSON.stringify(entry));
            // Keep the body in a separate row so a policy update cannot rewrite its pages.
            database
              .prepare(
                'INSERT INTO cache_bodies VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body WHERE body IS NOT excluded.body',
              )
              .run(key, body);
            database.exec('COMMIT');
          } catch (error) {
            database.exec('ROLLBACK');
            throw error;
          }
        },
        delete(key: string) {
          return (
            database.prepare('DELETE FROM cache WHERE key = ?').run(key)
              .changes > 0
          );
        },
        clear() {
          database.exec('DELETE FROM cache');
        },
      },
    });
    this.#database = database;
    resources.move();
  }

  async [Symbol.asyncDispose]() {
    this.#database.close();
  }
}
