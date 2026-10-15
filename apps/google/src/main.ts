import { homedir } from 'node:os';
import { join } from 'node:path';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
  installPostgresCatalog,
} from '@workspace/elt-postgresql';
import {
  GOOGLE_HEALTH_SCOPES,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  googleSession,
} from '@workspace/google-auth';
import { GoogleHealthSource } from '@workspace/source-google-health/google-health-source';
import { SearchConsoleSource } from '@workspace/source-google-search-console/search-console-source';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret)
  throw new Error(
    'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com and health.googleapis.com enabled.',
  );

const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const schema = 'google_search_console';
const healthSchema = 'google_health';
const directory = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'context-compiler',
);

// Search Console, every stream, loaded into its raw schema; readers see each
// stream as marts.search_console_<stream>.
const requester = await googleSession({
  clientId,
  clientSecret,
  scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  directory,
});
const source = new SearchConsoleSource({
  requester,
  siteUrls: ['sc-domain:ezz.sh'],
});
const destination = new PostgresDestination({ url: warehouseUrl, schema });

// Google Health, every stream reloaded whole each pass into its raw schema;
// readers see each stream as marts.health_<stream>.
const health = new GoogleHealthSource({
  requester: await googleSession({
    clientId,
    clientSecret,
    scopes: GOOGLE_HEALTH_SCOPES,
    directory,
  }),
});
const healthDestination = new PostgresDestination({
  url: warehouseUrl,
  schema: healthSchema,
});

const history = new PostgresSyncHistory({ url: warehouseUrl });
await history.install();
await installPostgresCatalog({ url: warehouseUrl, schema: 'marts' });
const { streams } = await source.discover();
const { streams: healthStreams } = await health.discover();

await new Pipeline({
  history,
  connections: [
    new Connection({
      name: 'google-search-console',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url: warehouseUrl, schema }),
      steps: streams.map(
        (stream) =>
          new Copy(
            stream,
            destination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `search_console_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `search-console:${stream.name}`,
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            },
          ),
      ),
    }),
    new Connection({
      name: 'google-health',
      source: health,
      destination: healthDestination,
      checkpoints: new PostgresCheckpointStore({
        url: warehouseUrl,
        schema: healthSchema,
      }),
      steps: healthStreams.map(
        (stream) =>
          new Copy(
            stream,
            healthDestination
              .table(`raw_${stream.name}`)
              .withReaderView(
                'marts',
                `health_${stream.name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
              ),
            {
              id: `health:${stream.name}`,
              syncMode: 'full_refresh',
              destinationSyncMode: 'overwrite',
            },
          ),
      ),
    }),
  ],
}).run();
