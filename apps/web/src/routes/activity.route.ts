import { on } from 'node:events';

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { Services } from '../services.ts';

export default function (router: Hono, { activity, changes }: Services) {
  router.get('/activity', (c) =>
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
  );
}
