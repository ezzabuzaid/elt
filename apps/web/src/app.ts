import { join } from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

import activityRoute from './routes/activity.route.ts';
import articlesRoute from './routes/articles.route.ts';
import historyRoute from './routes/history.route.ts';
import settingsRoute from './routes/settings.route.ts';
import syncRoute from './routes/sync.route.ts';

const app = new Hono();
for (const route of [
  settingsRoute,
  syncRoute,
  activityRoute,
  articlesRoute,
  historyRoute,
]) {
  route(app.basePath('/api'));
}
app.use('/*', serveStatic({ root: join(import.meta.dirname, '../client') }));
// The page reads `error` from every failed reply; validate() puts the field
// errors in the cause.
app.onError((error, c) => {
  if (error instanceof HTTPException) {
    return c.json({ error: error.message, cause: error.cause }, error.status);
  }
  console.error(error);
  return c.json({ error: 'Internal Server Error' }, 500);
});

export default app;
