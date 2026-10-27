import { writeFile } from 'node:fs/promises';

import type { Hono } from 'hono';
import { z } from 'zod';

import { settingsSchema } from '../contract.ts';
import type { Services } from '../services.ts';

export default function (
  router: Hono,
  { settingsPath, readSettings }: Services,
) {
  router.get('/settings', async (c) => c.json(await readSettings()));

  router.put('/settings', async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: z.prettifyError(parsed.error) }, 400);
    await writeFile(settingsPath, JSON.stringify(parsed.data, null, 2));
    return c.json(parsed.data);
  });
}
