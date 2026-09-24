import { randomUUID } from 'node:crypto';

import { PostgresCheckpointStore, PostgresDestination } from 'elt-postgresql';
import postgres from 'postgres';

export const testServer =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

export const RAW = 'google_search_console';

/**
 * A database of its own for one test, dropped when the test ends: the
 * Search Console destination and checkpoints in the raw schema, and a
 * session whose unqualified names resolve there.
 */
export async function scratchWarehouse() {
  const admin = postgres(testServer, { max: 1, onnotice: () => {} });
  const name = `gsc_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      `Test Postgres at ${new URL(testServer).host} is unavailable. Start it with: docker compose -f infra/docker-compose.yml up -d --wait`,
      { cause },
    );
  }
  const url = new URL(testServer);
  url.pathname = `/${name}`;
  const sql = postgres(url.href, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: RAW },
  });
  return {
    url: url.href,
    sql,
    destination: new PostgresDestination({ url: url.href, schema: RAW }),
    checkpoints: new PostgresCheckpointStore({ url: url.href, schema: RAW }),
    async [Symbol.asyncDispose]() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
