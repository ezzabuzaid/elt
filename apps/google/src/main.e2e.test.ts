import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

import postgres from 'postgres';

const entry = join(import.meta.dirname, 'main.js');

test('without an OAuth client the app names the variables to set and exits 1', () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== 'GOOGLE_OAUTH_CLIENT_ID' &&
        name !== 'GOOGLE_OAUTH_CLIENT_SECRET',
    ),
  );

  const { status, stderr } = spawnSync(process.execPath, [entry], {
    env,
    encoding: 'utf8',
  });

  assert.equal(status, 1);
  assert.match(stderr, /Set GOOGLE_OAUTH_CLIENT_ID/);
});

// Local only: the run reads the real Search Console and Google Health with
// the grant stored in ~/.config/elt and the OAuth client in the
// root .env, which Nx loads, and loads the local warehouse (npx nx run
// infra:up). A whole Google Health history takes minutes. spawnSync's timeout
// ends a run that hangs; node:test's own timeout cannot fire while spawnSync
// blocks.
test('one pass loads every stream behind its marts reader view and records a succeeded sync', async () => {
  const warehouse = postgres(
    'postgres://warehouse:warehouse@127.0.0.1:55432/warehouse',
    { max: 1, onnotice: () => {} },
  );
  const reader = postgres(
    'postgres://agent_reader:agent@127.0.0.1:55432/warehouse',
    { max: 1, onnotice: () => {} },
  );
  try {
    // The warehouse's clock, which stamps started_at.
    const [before] = await warehouse<
      { now: Date }[]
    >`SELECT clock_timestamp() AS now`;
    assert.ok(before);

    const { status, stderr } = spawnSync(process.execPath, [entry], {
      // With no stored grant, googleSession would open the consent page with
      // `open`; an empty PATH makes that fail at once, with the reason in
      // stderr, instead of opening a browser on the user's screen.
      env: { ...process.env, PATH: '' },
      encoding: 'utf8',
      timeout: 900_000,
    });

    assert.equal(status, 0, stderr);
    const views = await warehouse<{ viewname: string }[]>`
      SELECT viewname FROM pg_views
      WHERE schemaname = 'marts' AND starts_with(viewname, 'search_console_')
      ORDER BY viewname COLLATE "C"`;
    assert.deepEqual(
      views.map(({ viewname }) => viewname),
      [
        'search_console_search_analytics_countries',
        'search_console_search_analytics_daily',
        'search_console_search_analytics_pages',
        'search_console_search_analytics_queries',
        'search_console_sitemap_contents',
        'search_console_sitemaps',
        'search_console_sites',
        'search_console_url_inspection',
        'search_console_url_inspection_referrers',
        'search_console_url_inspection_sitemaps',
      ],
    );
    for (const { viewname } of views)
      await reader`SELECT * FROM marts.${reader(viewname)} LIMIT 1`;
    const health = await warehouse<{ viewname: string }[]>`
      SELECT viewname FROM pg_views
      WHERE schemaname = 'marts' AND starts_with(viewname, 'health_')`;
    // Every Google Health stream, from heart rate to the account's devices.
    assert.equal(health.length, 56);
    for (const { viewname } of health)
      await reader`SELECT * FROM marts.${reader(viewname)} LIMIT 1`;
    // The account's Apple Watch reaches Google Health through the Google
    // Health iPhone app, which marks its points HEALTH_KIT.
    const [relayed] = await reader<{ points: number }[]>`
      SELECT count(*)::int AS points FROM marts.health_steps
      WHERE platform = 'HEALTH_KIT'`;
    assert.ok((relayed?.points ?? 0) > 0, 'Apple Health points arrived');
    const attempts = await warehouse<{ connector: string; status: string }[]>`
      SELECT connector, status FROM _warehouse.sync_attempts
      WHERE started_at > ${before.now} ORDER BY connector`;
    assert.deepEqual(
      attempts.map(({ connector, status }) => [connector, status]),
      [
        ['google-health', 'succeeded'],
        ['google-search-console', 'succeeded'],
      ],
    );
  } finally {
    await warehouse.end();
    await reader.end();
  }
});
