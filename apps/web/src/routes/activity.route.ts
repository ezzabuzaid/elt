import { setTimeout } from 'node:timers/promises';

import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import activity from '../activity.ts';

// A crawl changes the run many times a second, so a page gets the run at most
// this often, as one snapshot of every change since the last.
const interval = 100;

export default function (router: Hono) {
  router.get('/activity', (c) =>
    streamSSE(c, async (stream) => {
      const { signal } = c.req.raw;
      const changes = activity.changes(signal);
      let sent = activity.version;
      await stream.writeSSE({ data: JSON.stringify(activity.current) });
      try {
        for await (const [version] of changes) {
          if (version <= sent) {
            continue;
          }
          await setTimeout(interval, undefined, { signal });
          sent = activity.version;
          await stream.writeSSE({ data: JSON.stringify(activity.current) });
        }
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
    }),
  );
}
