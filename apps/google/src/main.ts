import { homedir } from 'node:os';
import { join } from 'node:path';

import { Connection, Copy, Pipeline } from '@eltjs/elt';
import {
  PostgresCheckpointStore,
  PostgresDestination,
  PostgresSyncHistory,
} from '@eltjs/elt-postgresql';
import {
  GOOGLE_HEALTH_SCOPES,
  GOOGLE_SEARCH_CONSOLE_SCOPE,
  googleSession,
} from '@eltjs/google-auth';
import { GoogleHealthSource } from '@eltjs/source-google-health/google-health-source';
import { SearchConsoleSource } from '@eltjs/source-google-search-console/search-console-source';

const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
if (!clientId || !clientSecret)
  throw new Error(
    'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com and health.googleapis.com enabled.',
  );

const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const directory = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'elt',
);

// Search Console, every stream; readers see each stream as
// marts.search_console_<stream>.
const requester = await googleSession({
  clientId,
  clientSecret,
  scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  directory,
  clock: globalThis,
});
const source = new SearchConsoleSource({
  requester,
  siteUrls: ['sc-domain:ezz.sh'],
});
const destination = new PostgresDestination({ url: warehouseUrl });

// Google Health, every stream reloaded whole each pass; readers see each
// stream as marts.health_<stream>.
const health = new GoogleHealthSource({
  requester: await googleSession({
    clientId,
    clientSecret,
    scopes: GOOGLE_HEALTH_SCOPES,
    directory,
    clock: globalThis,
  }),
});

const { streams } = await source.discover();
const { streams: healthStreams } = await health.discover();

await new Pipeline({
  clock: globalThis,
  history: new PostgresSyncHistory({ url: warehouseUrl }),
  connections: [
    new Connection({
      name: 'google-search-console',
      source,
      destination,
      checkpoints: new PostgresCheckpointStore({ url: warehouseUrl }),
      steps: streams.map(
        (stream) =>
          new Copy(
            stream,
            destination.table(
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
      destination,
      checkpoints: new PostgresCheckpointStore({ url: warehouseUrl }),
      steps: healthStreams.map(
        (stream) =>
          new Copy(
            stream,
            destination.table(
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
