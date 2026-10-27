import { DatabaseSync } from 'node:sqlite';

import type { Hono } from 'hono';
import { z } from 'zod';

import { articleSchema, articleSummarySchema } from '../contract.ts';
import type { Services } from '../services.ts';

export default function (router: Hono, { articlesPath }: Services) {
  const read = <T>(query: (database: DatabaseSync) => T, empty: T): T => {
    using database = new DatabaseSync(articlesPath, {
      readOnly: true,
      timeout: 5_000,
    });
    const loaded = database
      .prepare(`SELECT 1 FROM sqlite_schema WHERE name = 'articles'`)
      .get();
    return loaded === undefined ? empty : query(database);
  };

  router.get('/articles', (c) =>
    c.json(
      read(
        (database) =>
          z.array(articleSummarySchema).parse(
            database
              .prepare(
                `SELECT inputUrl, articleUrl, pageUrl, listingUrl, lastModified, title, byline, publishedTime, excerpt, siteName, length
                FROM articles ORDER BY publishedTime IS NULL, publishedTime DESC, title`,
              )
              .all(),
          ),
        [],
      ),
    ),
  );

  router.get('/article', (c) => {
    const article = read(
      (database) =>
        database
          .prepare(
            'SELECT * FROM articles WHERE inputUrl = ? AND articleUrl = ?',
          )
          .get(c.req.query('inputUrl') ?? '', c.req.query('articleUrl') ?? ''),
      undefined,
    );
    return article === undefined
      ? c.json({ error: 'No such article' }, 404)
      : c.json(articleSchema.parse(article));
  });
}
