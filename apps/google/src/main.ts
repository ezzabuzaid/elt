import { Pipeline, PipelineError } from 'elt';
import { PostgresCheckpointStore, PostgresDestination } from 'elt-postgresql';
import { GOOGLE_SEARCH_CONSOLE_SCOPE } from 'google-auth';
import postgres from 'postgres';

import {
  googleSession,
  grantDirectory,
  installSearchConsoleMarts,
  installWarehouse,
  OAuthCallbackTimeoutError,
  SearchConsoleSource,
  searchConsoleCopies,
} from './index.ts';

class MissingClientError extends Error {
  override readonly name = 'MissingClientError';
  constructor() {
    super(
      `Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to a Desktop-type OAuth client whose project has searchconsole.googleapis.com enabled. Grants are stored under ${grantDirectory()}.`,
    );
  }
}

const siteUrls = ['sc-domain:ezz.sh'];
// The warehouse and reader role infra/docker-compose.yml creates.
const warehouseUrl = 'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse';
const reader = 'agent_reader';
const raw = 'google_search_console';

try {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new MissingClientError();
  // The first run opens a browser for consent; later runs reuse the stored
  // grant. Quota is billed to the OAuth client's own project.
  const requester = await googleSession({
    clientId,
    clientSecret,
    scopes: [GOOGLE_SEARCH_CONSOLE_SCOPE],
  });
  // One source reads every property as a partition of each stream, so each
  // table has one writer and each property keeps its own checkpoint.
  const source = new SearchConsoleSource({ requester, siteUrls });
  const destination = new PostgresDestination({
    url: warehouseUrl,
    schema: raw,
  });
  // Every copy runs even when one property fails; a failed property keeps its
  // checkpoint and is retried from there on the next run.
  const outcomes = await new Pipeline({
    source,
    destination,
    checkpoints: new PostgresCheckpointStore({
      url: warehouseUrl,
      schema: raw,
    }),
    steps: searchConsoleCopies(source, (name) => destination.table(name)),
  })
    .run()
    .then(
      (results) => results.map((result) => ({ ...result, failures: [] })),
      (error: unknown) => {
        if (
          !(error instanceof PipelineError) ||
          error.cause instanceof MissingClientError ||
          error.cause instanceof OAuthCallbackTimeoutError
        )
          throw error;
        return error.results;
      },
    );
  console.table(
    outcomes.map(({ copy, count, deleted, failures }) => ({
      stream: copy.from.name,
      table: copy.to.name,
      count,
      deleted,
      status:
        failures.length === 0
          ? 'complete'
          : `failed: ${failures.map(({ partition }) => partition?.siteUrl ?? 'all properties').join(', ')}`,
    })),
  );
  const failures = outcomes.flatMap(({ copy, failures }) =>
    failures.map(
      ({ partition, error }) =>
        `${copy.from.name} ${partition?.siteUrl ?? 'all properties'}: ${error instanceof Error ? error.message : String(error)}`,
    ),
  );
  for (const failure of failures) console.error(failure);
  console.log(
    failures.length === 0
      ? `Loaded Search Console for ${siteUrls.join(', ')} into ${raw}`
      : `Loaded Search Console into ${raw} with ${failures.length} failed stream and property pairs; they resume from their last checkpoint next run`,
  );
  if (failures.length > 0) process.exitCode = 1;
  const sql = postgres(warehouseUrl, { max: 1, onnotice: () => {} });
  try {
    await installWarehouse(sql, { reader });
    await installSearchConsoleMarts(sql, { raw, reader });
    // Query rows never add up to the daily totals, because Google withholds
    // rare queries. Showing both is the point of keeping the grains apart.
    console.table(
      await sql`SELECT * FROM marts.search_console_withheld_daily ORDER BY date DESC, site_url LIMIT 10`,
    );
  } finally {
    await sql.end();
  }
} catch (error) {
  const cause = error instanceof PipelineError ? error.cause : error;
  if (
    !(cause instanceof MissingClientError) &&
    !(cause instanceof OAuthCallbackTimeoutError)
  )
    throw error;
  console.error(cause.message);
  process.exitCode = 1;
}
