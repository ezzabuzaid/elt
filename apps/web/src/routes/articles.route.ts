import { validate } from '@sdk-it/hono/runtime';
import type { Hono } from 'hono';
import { z } from 'zod';

import { articleSchema, articleSummarySchema } from '../contract.ts';
import db from '../db.ts';

// The articles table appears with the first sync's first record.
const loaded = () =>
  db.prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'articles'`).get() !==
  undefined;

export default function (router: Hono) {
  router.get('/articles', (c) =>
    c.json(
      loaded()
        ? z.array(articleSummarySchema).parse(
            db
              .prepare(
                `SELECT inputUrl, articleUrl, pageUrl, listingUrl, lastModified, title, byline, publishedTime, excerpt, siteName, length
                FROM articles ORDER BY publishedTime IS NULL, publishedTime DESC, title`,
              )
              .all(),
          )
        : [],
    ),
  );

  router.get(
    '/article',
    validate((payload) => ({
      inputUrl: { select: payload.query.inputUrl, against: z.string() },
      articleUrl: { select: payload.query.articleUrl, against: z.string() },
    })),
    (c) => {
      const { inputUrl, articleUrl } = c.var.input;
      const article = loaded()
        ? db
            .prepare(
              'SELECT * FROM articles WHERE inputUrl = ? AND articleUrl = ?',
            )
            .get(inputUrl, articleUrl)
        : undefined;
      if (article === undefined) {
        return c.json({ error: 'No such article' }, 404);
      }
      return c.json(articleSchema.parse(article));
    },
  );
}
