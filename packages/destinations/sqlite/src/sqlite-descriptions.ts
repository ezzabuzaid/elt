import type { DatabaseSync } from 'node:sqlite';

// SQLite has no COMMENT ON. Relation and column meanings live here instead,
// beside what they describe, and the catalog view shows them to readers.
export const descriptions = '"_mac_elt_descriptions"';

export type ColumnDescription = {
  readonly description: string | null;
  readonly dataType?: string;
};

export function createDescriptions(database: DatabaseSync): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${descriptions} ("relation" TEXT NOT NULL COLLATE NOCASE, "column" TEXT NOT NULL COLLATE NOCASE, "data_type" TEXT, "description" TEXT NOT NULL, PRIMARY KEY ("relation", "column")) STRICT`,
  );
}

// Replaces what a relation says about itself and its columns; a column
// without a description says nothing, as a Postgres comment set to NULL.
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
  const insert = database.prepare(
    `INSERT INTO ${descriptions} ("relation", "column", "data_type", "description") VALUES (?, ?, ?, ?)`,
  );
  insert.run(relation, '', null, description);
  for (const [column, { description, dataType }] of Object.entries(columns))
    if (description !== null)
      insert.run(relation, column, dataType ?? null, description);
}
