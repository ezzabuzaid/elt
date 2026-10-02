import { DatabaseSync } from 'node:sqlite';

import { readerCatalog } from '@workspace/elt';

import { createDescriptions, descriptions } from './sqlite-descriptions.ts';
import { publishSQLiteViews } from './sqlite-views.ts';

// Lists what readers of one file can query: every described view and its
// columns, from what loads and publications wrote there; safe to repeat.
// Every column of a described view is described: loads refuse a reader view
// with an undescribed column, and publications describe exactly their columns.
export function installSQLiteCatalog({ path }: { path: string }): void {
  if (path === ':memory:')
    throw new TypeError('A SQLite catalog requires a database file');
  using database = new DatabaseSync(path, { timeout: 30_000 });
  database.exec('BEGIN IMMEDIATE');
  try {
    createDescriptions(database);
    publishSQLiteViews(database, {
      views: [
        {
          ...readerCatalog,
          query: `SELECT 'view' AS "kind", s."name" AS "name", NULL AS "data_type", d."description" AS "description"
            FROM sqlite_schema s JOIN ${descriptions} d ON d."relation" = s."name" AND d."column" = ''
            WHERE s."type" = 'view'
            UNION ALL
            SELECT 'column', s."name" || '.' || c."column", c."data_type", c."description"
            FROM sqlite_schema s JOIN ${descriptions} d ON d."relation" = s."name" AND d."column" = ''
            JOIN ${descriptions} c ON c."relation" = s."name" AND c."column" <> ''
            WHERE s."type" = 'view'
            ORDER BY 2`,
        },
      ],
    });
    database.exec('COMMIT');
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
