import {
  PostgresCheckpointStore,
  PostgresDestination,
} from '@workspace/elt-postgresql';
import { scratchDatabase } from '@workspace/elt-postgresql/testing';

export const RAW = 'google_search_console';

/**
 * A database of its own on server for one test, dropped when the test ends: the
 * Search Console destination and checkpoints in the raw schema, and a
 * session whose unqualified names resolve there.
 */
export async function searchConsoleDatabase(server: string) {
  const database = await scratchDatabase(server, {
    max: 1,
    connection: { search_path: RAW },
  });
  return {
    url: database.url,
    sql: database.sql,
    destination: new PostgresDestination({ url: database.url, schema: RAW }),
    checkpoints: new PostgresCheckpointStore({
      url: database.url,
      schema: RAW,
    }),
    [Symbol.asyncDispose]: () => database[Symbol.asyncDispose](),
  };
}
