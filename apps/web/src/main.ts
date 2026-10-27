import { EventEmitter, on } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { SingleFlight } from '@zukhruf/single-flight';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';

import { Connection, Copy, Pipeline } from '@workspace/elt';
import {
  SQLiteCheckpointStore,
  SQLiteDestination,
  SQLiteSyncHistory,
} from '@workspace/elt-sqlite';
import {
  ArchiveReader,
  LinkReader,
  ListingReader,
  PaginationReader,
} from '@workspace/sdk-web-crawler';
import { ArticleExtractor } from '@workspace/source-web-pages/article-extractor';
import { WebSource } from '@workspace/source-web-pages/web-source';
import { WebStream } from '@workspace/source-web-pages/web-stream';

import {
  type Activity,
  articleSchema,
  articleSummarySchema,
  attemptSchema,
  settingsSchema,
} from './contract.ts';

const directory = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
  'elt',
  'web',
);
const settingsPath = join(directory, 'sites.json');
const articlesPath = join(directory, 'articles.sqlite');
const checkpointsPath = join(directory, 'checkpoints.sqlite');
const connector = 'web';
const flightsDirectory = join(directory, 'flights');
await mkdir(flightsDirectory, { recursive: true });

// Every site is one partition of a single WebSource, so one connection is the
// articles table's only writer.
const destination = new SQLiteDestination({ path: articlesPath });
const history = new SQLiteSyncHistory();
await history.install([destination]);

const readSettings = async () =>
  existsSync(settingsPath)
    ? settingsSchema.parse(JSON.parse(await readFile(settingsPath, 'utf8')))
    : { inputs: [], include: [] };

const pipeline = async () => {
  const { inputs, include } = await readSettings();
  const source = new WebSource({
    stream: new WebStream({
      name: 'articles',
      primaryKey: ['articleUrl'],
      readers: [
        new ListingReader(),
        new ArchiveReader(),
        new PaginationReader(),
        new LinkReader({ maxDepth: 3, maxPages: 100 }),
      ],
      include:
        include.length === 0
          ? undefined
          : include.map((pattern) => new URLPattern(pattern)),
      extractor: new ArticleExtractor(),
    }),
    inputs,
  });
  return new Pipeline({
    history,
    observer: {
      begin: () => ({
        progress: ({ status, emitted, committed }) =>
          publish({
            kind: 'syncing',
            progress: { status, emitted, committed },
          }),
        finish: () => undefined,
        fail: () => undefined,
      }),
    },
    connections: [
      new Connection({
        name: connector,
        source,
        destination,
        checkpoints: new SQLiteCheckpointStore({ path: checkpointsPath }),
        steps: (await source.discover()).streams.map(
          (stream) =>
            new Copy(stream, destination.table(stream.name), {
              id: 'web:articles',
              syncMode: 'incremental',
              destinationSyncMode: 'append_dedup',
            }),
        ),
      }),
    ],
  });
};

// EventEmitter keeps no last value, and a page that connects mid-sync needs it.
const activity: { current: Activity } = { current: { kind: 'idle' } };
const changes = new EventEmitter<{ change: [Activity] }>();
const publish = (next: Activity) => {
  activity.current = next;
  changes.emit('change', next);
};

// A Sync or Clear while the same one runs joins it, in this process or another
// that uses the folder. A Clear during a Sync is refused by elt's checkpoint
// lock.
const flights = new SingleFlight<void>({
  directory: flightsDirectory,
  codec: { encode: () => '', decode: () => undefined },
});

const read = <T>(query: (database: DatabaseSync) => T, empty: T): T => {
  using database = new DatabaseSync(articlesPath, {
    readOnly: true,
    timeout: 5_000,
  });
  const loaded = database
    .prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'articles'`)
    .get();
  return loaded === undefined ? empty : query(database);
};

const json = z.string().transform((value) => z.json().parse(JSON.parse(value)));
const attemptRow = attemptSchema.extend({
  selection: json.nullable(),
  failures: json.nullable(),
});

const app = new Hono()
  .get('/api/settings', async (c) => c.json(await readSettings()))
  .put('/api/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    await writeFile(settingsPath, JSON.stringify(parsed.data, null, 2));
    return c.json(parsed.data);
  })
  .post('/api/sync', async (c) => {
    if ((await readSettings()).inputs.length === 0)
      return c.json({ error: 'Add a site first' }, 400);
    void flights
      .run('sync', async () => {
        publish({ kind: 'syncing', progress: null });
        try {
          await (await pipeline()).run();
        } finally {
          publish({ kind: 'idle' });
        }
      })
      .catch((error: unknown) => console.error(error));
    return c.body(null, 202);
  })
  .post('/api/clear', async (c) => {
    if ((await readSettings()).inputs.length === 0)
      return c.json({ error: 'Add a site first' }, 400);
    try {
      await flights.run('clear', async () => {
        await (await pipeline()).clear();
      });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
    return c.body(null, 204);
  })
  .get('/api/activity', (c) =>
    streamSSE(c, async (stream) => {
      const { signal } = c.req.raw;
      // Subscribed before the first write, so a change during it is buffered.
      const next = on(changes, 'change', { signal });
      await stream.writeSSE({ data: JSON.stringify(activity.current) });
      try {
        for await (const [change] of next)
          await stream.writeSSE({ data: JSON.stringify(change) });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }),
  )
  .get('/api/articles', (c) =>
    c.json(
      read(
        (database) =>
          z.array(articleSummarySchema).parse(
            database
              .prepare(
                `SELECT inputUrl, articleUrl, pageUrl, listingUrl, lastModified, title, byline, publishedTime, excerpt, siteName, length
                FROM articles ORDER BY publishedTime IS NULL, publishedTime DESC, title`,
              )
              .all(),
          ),
        [],
      ),
    ),
  )
  .get('/api/article', (c) => {
    const article = read(
      (database) =>
        database
          .prepare(
            'SELECT * FROM articles WHERE inputUrl = ? AND articleUrl = ?',
          )
          .get(c.req.query('inputUrl') ?? '', c.req.query('articleUrl') ?? ''),
      undefined,
    );
    return article === undefined
      ? c.json({ error: 'No such article' }, 404)
      : c.json(articleSchema.parse(article));
  })
  .get('/api/history', (c) => {
    using database = new DatabaseSync(articlesPath, {
      readOnly: true,
      timeout: 5_000,
    });
    const status = z
      .object({
        current_as_of: z.string().nullable(),
        last_successful_sync_at: z.string().nullable(),
      })
      .optional()
      .parse(
        database
          .prepare(
            'SELECT current_as_of, last_successful_sync_at FROM sync_status WHERE connector = ?',
          )
          .get(connector),
      );
    const attempts = z.array(attemptRow).parse(
      database
        .prepare(
          `SELECT a.attempt_id, a.started_at, a.completed_at, a.status, a.error, a.failure_type,
            c.description, c.selection, c.written_count, c.deleted_count, c.failures
          FROM sync_attempts a LEFT JOIN extraction_coverage c ON c.attempt_id = a.attempt_id
          WHERE a.connector = ? ORDER BY a.attempt_id DESC LIMIT 20`,
        )
        .all(connector),
    );
    return c.json({
      currentAsOf: status?.current_as_of ?? null,
      lastSuccessfulSyncAt: status?.last_successful_sync_at ?? null,
      attempts,
    });
  })
  .use('/*', serveStatic({ root: join(import.meta.dirname, '../client') }));

const port = Number(process.env.PORT ?? 4310);
serve({ fetch: app.fetch, port }, () =>
  console.log(`elt web on http://localhost:${port}`),
);
