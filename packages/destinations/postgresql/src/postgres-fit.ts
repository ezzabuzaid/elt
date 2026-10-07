import type { StoredFit } from '@workspace/elt';

import type { Transaction } from './postgres-load.ts';
import type { PostgresTable } from './postgres-table.ts';

// Whether a stored table has the columns, types and NOT NULL the stream
// needs. The stage is built from the same column declarations, so Postgres
// spells both alike.
export async function storedFit(
  sql: Transaction,
  target: PostgresTable,
  table: string,
  stage: string,
): Promise<StoredFit> {
  const columns = (relation: string) =>
    sql.unsafe<{ name: string; type: string; required: boolean }[]>(
      'SELECT attname AS name, format_type(atttypid, atttypmod) AS type, attnotnull AS required FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped',
      [relation],
    );
  const stored = await columns(table);
  if (stored.length === 0) return 'missing';
  const types = new Map(
    (await columns(`pg_temp.${stage}`)).map(({ name, type }) => [name, type]),
  );
  const needed = [
    ...target.columns.map(
      (column) =>
        `${column.name} ${types.get(column.name)} ${column.required || column.isPrimaryKey}`,
    ),
    'loaded_at timestamp with time zone true',
  ];
  const has = stored.map(
    ({ name, type, required }) => `${name} ${type} ${required}`,
  );
  return needed.sort().join('\0') === has.sort().join('\0') ? 'fits' : 'stale';
}
