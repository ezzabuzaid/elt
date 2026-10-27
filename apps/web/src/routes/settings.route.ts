import type { Hono } from 'hono';
import { z } from 'zod';

import { settingsSchema } from '../contract.ts';
import settings from '../settings.ts';

export default function (router: Hono) {
  router.get('/settings', async (c) => c.json(await settings.read()));

  router.put('/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    await settings.save(parsed.data);
    return c.json(parsed.data);
  });
}
