import { Pipeline, PipelineError } from 'elt';
import { PostgresCheckpointStore, PostgresDestination } from 'elt-postgresql';
import {
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  googleSession,
  grantDirectory,
} from 'google-auth';
import postgres from 'postgres';
import { searchConsoleCopies } from './sources/search-console/search-console-copies.ts';
import { SearchConsoleSource } from './sources/search-console/search-console-source.ts';
import { installSearchConsoleMarts } from './warehouse/search-console-marts.ts';
import { installWarehouse } from './warehouse/warehouse.ts';

const siteUrls = ['sc-domain:ezz.sh'];
const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const reader = 'agent_reader';
const raw = 'google_search_console';

export default [
  {
    name: 'google-search-console',
    async run() {
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret)
        throw new Error(
          `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com enabled. Grants are stored under ${grantDirectory()}.`,
        );
      const requester = await googleSession({
        clientId,
        clientSecret,
        scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
      });
      const source = new SearchConsoleSource({ requester, siteUrls });
      const destination = new PostgresDestination({
        url: warehouseUrl,
        schema: raw,
      });
      await new Pipeline({
        source,
        destination,
        checkpoints: new PostgresCheckpointStore({
          url: warehouseUrl,
          schema: raw,
        }),
        steps: searchConsoleCopies(source, (name) => destination.table(name)),
      })
        .run()
        .catch((error: unknown) => {
          if (!(error instanceof PipelineError)) throw error;
          // Keep the marts current after a partial load as well.
          process.exitCode = 1;
        });
      const sql = postgres(warehouseUrl, { max: 1, onnotice: () => {} });
      try {
        await installWarehouse(sql, { reader });
        await installSearchConsoleMarts(sql, { raw, reader });
      } finally {
        await sql.end();
      }
    },
  },
];
