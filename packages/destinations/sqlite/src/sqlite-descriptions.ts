import type { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@workspace/sqlite-drift';

import { identifiers } from './sqlite-identifiers.ts';

// SQLite has no COMMENT ON. Relation and column meanings live here instead,
// beside what they describe, and the catalog view shows them to readers.
export const descriptions = '"_elt_descriptions"';

const descriptionsTable = new Declaration([
  `CREATE TABLE ${descriptions} ("relation" TEXT NOT NULL COLLATE NOCASE, "column" TEXT NOT NULL COLLATE NOCASE, "data_type" TEXT, "description" TEXT NOT NULL, PRIMARY KEY ("relation", "column")) STRICT`,
]);

export type ColumnDescription = {
  readonly description: string | null;
  readonly dataType?: string;
};

// A table another version declared otherwise is replaced; the next commit or
// publication of each relation describes it again.
export function createDescriptions(database: DatabaseSync): void {
  descriptionsTable.apply(database);
}

// Replaces what a relation says about itself and its columns; a column
// without a description says nothing, as a Postgres comment set to NULL. A
// column without a stated type keeps the type SQLite declares for it, read
// here because the catalog view cannot: shells keep a schema untrusted, which
// refuses pragma functions inside views.
export function describe(
  database: DatabaseSync,
  relation: string,
  description: string,
  columns: Readonly<Record<string, ColumnDescription>>,
): void {
  createDescriptions(database);
  database.exec(
    `DELETE FROM ${descriptions} WHERE "relation" NOT IN (SELECT "name" FROM sqlite_schema)`,
  );
  database
    .prepare(`DELETE FROM ${descriptions} WHERE "relation" = ?`)
    .run(relation);
  const declared = new Map(
    database
      .prepare('SELECT "name", "type" FROM pragma_table_info(?)')
      .all(relation)
      .map(({ name, type }) => [
        identifiers.key(String(name)),
        String(type).toLowerCase() || null,
      ]),
  );
  const insert = database.prepare(
    `INSERT INTO ${descriptions} ("relation", "column", "data_type", "description") VALUES (?, ?, ?, ?)`,
  );
  insert.run(relation, '', null, description);
  for (const [column, { description, dataType }] of Object.entries(columns))
    if (description !== null)
      insert.run(
        relation,
        column,
        dataType ?? declared.get(identifiers.key(column)) ?? null,
        description,
      );
}
