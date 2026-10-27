import { serve } from '@hono/node-server';

import app from './app.ts';

const port = Number(process.env.PORT ?? 4310);
serve({ fetch: app.fetch, port }, () =>
  console.log(`elt web on http://localhost:${port}`),
);
