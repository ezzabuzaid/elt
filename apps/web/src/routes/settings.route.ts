import { validate } from '@sdk-it/hono/runtime';
import type { Hono } from 'hono';

import { settingsSchema } from '../contract.ts';
import settings from '../settings.ts';

export default function (router: Hono) {
  router.get('/settings', async (c) => c.json(await settings.read()));

  router.put(
    '/settings',
    validate((payload) => ({
      inputs: {
        select: payload.body.inputs,
        against: settingsSchema.shape.inputs,
      },
      include: {
        select: payload.body.include,
        against: settingsSchema.shape.include,
      },
    })),
    async (c) => {
      await settings.save(c.var.input);
      return c.json(c.var.input);
    },
  );
}
