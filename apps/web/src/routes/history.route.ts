import { DatabaseSync } from 'node:sqlite';

import type { Hono } from 'hono';
import { z } from 'zod';

import { attemptSchema } from '../contract.ts';
import type { Services } from '../services.ts';

const json = z.string().transform((value) => z.json().parse(JSON.parse(value)));
const attemptRow = attemptSchema.extend({
  selection: json.nullable(),
  failures: json.nullable(),
});

export default function (router: Hono, { articlesPath, connector }: Services) {
  router.get('/history', (c) => {
    using database = new DatabaseSync(articlesPath, {
      readOnly: true,
      timeout: 5_000,
    });
    const status = z
      .object({
        current_as_of: z.string().nullable(),
        last_successful_sync_at: z.string().nullable(),
      })
      .optional()
      .parse(
        database
          .prepare(
            'SELECT current_as_of, last_successful_sync_at FROM sync_status WHERE connector = ?',
          )
          .get(connector),
      );
    const attempts = z.array(attemptRow).parse(
      database
        .prepare(
          `SELECT a.attempt_id, a.started_at, a.completed_at, a.status, a.error, a.failure_type,
            c.description, c.selection, c.written_count, c.deleted_count, c.failures
          FROM sync_attempts a LEFT JOIN extraction_coverage c ON c.attempt_id = a.attempt_id
          WHERE a.connector = ? ORDER BY a.attempt_id DESC LIMIT 20`,
        )
        .all(connector),
    );
    return c.json({
      currentAsOf: status?.current_as_of ?? null,
      lastSuccessfulSyncAt: status?.last_successful_sync_at ?? null,
      attempts,
    });
  });
}
