import { readerCatalog } from 'elt';
import { quote } from './identifier.ts';
import { PostgresSession, schemaName } from './postgres-session.ts';
import { publishPostgresViews } from './postgres-views.ts';

// Lists what readers of one schema can query, from the comments every load
// and publication writes there; safe to repeat.
export async function installPostgresCatalog({
  url,
  schema,
}: {
  url: string;
  schema: string;
}): Promise<void> {
  const namespace = `'${quote(schemaName(schema)).replaceAll("'", "''")}'::regnamespace`;
  await using session = new PostgresSession(url, 'elt-catalog');
  await session.sql.begin((transaction) =>
    publishPostgresViews(transaction, {
      schema,
      views: [
        {
          ...readerCatalog,
          query: `SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
              c.relname::text AS name, NULL::text AS data_type,
              obj_description(c.oid, 'pg_class') AS description
            FROM pg_class c
            WHERE c.relnamespace = ${namespace} AND c.relkind IN ('v', 'r')
            UNION ALL
            SELECT 'column', c.relname || '.' || a.attname,
              format_type(a.atttypid, a.atttypmod), col_description(c.oid, a.attnum)
            FROM pg_class c
            JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            WHERE c.relnamespace = ${namespace} AND c.relkind IN ('v', 'r')
            ORDER BY 2`,
        },
      ],
    }),
  );
}
