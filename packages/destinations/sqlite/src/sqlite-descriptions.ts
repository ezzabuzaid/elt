import type { DatabaseSync } from 'node:sqlite';

// SQLite has no COMMENT ON. Relation and column meanings live here instead,
// beside what they describe, and the catalog view shows them to readers.
export const descriptions = '"_elt_descriptions"';

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
        String(name).toLowerCase(),
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
        dataType ?? declared.get(column.toLowerCase()) ?? null,
        description,
      );
}
