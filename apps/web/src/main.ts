import { join } from 'node:path';

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import activityRoute from './routes/activity.route.ts';
import articlesRoute from './routes/articles.route.ts';
import historyRoute from './routes/history.route.ts';
import settingsRoute from './routes/settings.route.ts';
import syncRoute from './routes/sync.route.ts';
import { createServices } from './services.ts';

const services = await createServices();
const app = new Hono();
for (const route of [
  settingsRoute,
  syncRoute,
  activityRoute,
  articlesRoute,
  historyRoute,
])
  route(app.basePath('/api'), services);
app.use('/*', serveStatic({ root: join(import.meta.dirname, '../client') }));

const port = Number(process.env.PORT ?? 4310);
serve({ fetch: app.fetch, port }, () =>
  console.log(`elt web on http://localhost:${port}`),
);
