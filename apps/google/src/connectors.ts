import { homedir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';

import { Connection, Pipeline, PipelineError } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  installPostgresCatalog,
} from '@workspace/elt-postgresql';
import {
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  googleSession,
} from '@workspace/google-auth';
import { searchConsoleCopies } from '@workspace/source-google-search-console/search-console-copies';
import { installSearchConsoleMarts } from '@workspace/source-google-search-console/search-console-marts';
import { SearchConsoleSource } from '@workspace/source-google-search-console/search-console-source';

const siteUrls = ['sc-domain:ezz.sh'];
const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const raw = 'google_search_console';

export default [
  {
    name: 'google-search-console',
    async run() {
      const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
      if (!clientId || !clientSecret)
        throw new Error(
          'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com enabled.',
        );
      const requester = await googleSession({
        clientId,
        clientSecret,
        scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
        directory: join(
          process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
          'context-compiler',
        ),
      });
      const source = new SearchConsoleSource({ requester, siteUrls });
      const destination = new PostgresDestination({
        url: warehouseUrl,
        schema: raw,
      });
      const history = new PostgresSyncHistory({ url: warehouseUrl });
      await history.install();
      await installPostgresCatalog({ url: warehouseUrl, schema: 'marts' });
      const pipeline = new Pipeline({
        history,
        connections: [
          new Connection({
            name: 'google-search-console',
            source,
            destination,
            checkpoints: new PostgresCheckpointStore({
              url: warehouseUrl,
              schema: raw,
            }),
            steps: searchConsoleCopies(source, (name) =>
              destination.table(name),
            ),
          }),
        ],
      });
      const sql = postgres(warehouseUrl, { max: 1, onnotice: () => {} });
      try {
        await pipeline.run().catch((error: unknown) => {
          if (!(error instanceof PipelineError)) throw error;
          // Keep the marts current after a partial load as well.
          process.exitCode = 1;
        });
        await installSearchConsoleMarts(sql, { raw });
      } finally {
        await sql.end();
      }
    },
  },
];
