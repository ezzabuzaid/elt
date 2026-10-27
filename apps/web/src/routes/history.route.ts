import type { Hono } from 'hono';
import { z } from 'zod';

import { attemptSchema } from '../contract.ts';
import db from '../db.ts';
import { connector } from '../pipeline.ts';

const json = z.string().transform((value) => z.json().parse(JSON.parse(value)));
const attemptRow = attemptSchema.extend({
  selection: json.nullable(),
  failures: json.nullable(),
});

// The pipeline installs its history views when the first Sync starts.
const installed = () =>
  db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'sync_status'`).get() !==
  undefined;

export default function (router: Hono) {
  router.get('/history', (c) => {
    if (!installed()) {
      return c.json({
        currentAsOf: null,
        lastSuccessfulSyncAt: null,
        attempts: [],
      });
    }
    const status = z
      .object({
        current_as_of: z.string().nullable(),
        last_successful_sync_at: z.string().nullable(),
      })
      .optional()
      .parse(
        db
          .prepare(
            'SELECT current_as_of, last_successful_sync_at FROM sync_status WHERE connector = ?',
          )
          .get(connector),
      );
    const attempts = z.array(attemptRow).parse(
      db
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
