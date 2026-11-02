import type { Hono } from 'hono';

import activity from '../activity.ts';
import flights from '../flights.ts';
import pipeline from '../pipeline.ts';
import settings from '../settings.ts';

export default function (router: Hono) {
  router.post('/sync', async (c) => {
    if ((await settings.read()).inputs.length === 0) {
      return c.json({ error: 'Add a site first' }, 400);
    }
    void flights
      .run('sync', async () => {
        activity.start();
        try {
          await (await pipeline()).run();
        } catch (error) {
          activity.fail(error);
          throw error;
        }
      })
      .catch((error: unknown) => console.error(error));
    return c.body(null, 202);
  });

  router.post('/clear', async (c) => {
    if ((await settings.read()).inputs.length === 0) {
      return c.json({ error: 'Add a site first' }, 400);
    }
    try {
      await flights.run('clear', async () => {
        await (await pipeline()).clear();
      });
    } catch (error) {
      return c.json({ error: String(error) }, 500);
    }
    return c.body(null, 204);
  });
}
