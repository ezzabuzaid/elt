import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import activity from '../activity.ts';

export default function (router: Hono) {
  router.get('/activity', (c) =>
    streamSSE(c, async (stream) => {
      const { signal } = c.req.raw;
      const changes = activity.changes(signal);
      await stream.writeSSE({ data: JSON.stringify(activity.current) });
      try {
        for await (const [change] of changes) {
          await stream.writeSSE({ data: JSON.stringify(change) });
        }
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
    }),
  );
}
