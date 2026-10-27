import type { Hono } from 'hono';

import type { Services } from '../services.ts';

export default function (
  router: Hono,
  { readSettings, flights, pipeline, publish }: Services,
) {
  router.post('/sync', async (c) => {
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
  });

  router.post('/clear', async (c) => {
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
  });
}
