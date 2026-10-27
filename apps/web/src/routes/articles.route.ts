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

  router.get('/article', (c) => {
    const article = loaded()
      ? db
          .prepare(
            'SELECT * FROM articles WHERE inputUrl = ? AND articleUrl = ?',
          )
          .get(c.req.query('inputUrl') ?? '', c.req.query('articleUrl') ?? '')
      : undefined;
    return article === undefined
      ? c.json({ error: 'No such article' }, 404)
      : c.json(articleSchema.parse(article));
  });
}
