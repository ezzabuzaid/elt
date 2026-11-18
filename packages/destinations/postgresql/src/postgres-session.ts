import postgres from 'postgres';

import { identifier, quote } from './identifier.ts';

// A session, or a transaction of one, for work that runs only statements.
export type Queries = Pick<postgres.Sql, 'unsafe'>;

// One session, closed however the work using it ends.
export class PostgresSession implements AsyncDisposable {
  readonly sql: postgres.Sql;

  constructor(url: string, applicationName: string) {
    this.sql = postgres(url, {
      max: 1,
      // postgres.js replaces a connection after 30 to 60 minutes by default,
      // which silently drops a session's TEMP stages and session locks.
      max_lifetime: null,
      onnotice: () => {},
      connection: { application_name: applicationName },
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

export function connectionUrl(url: string): string {
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
  )
    throw new TypeError('Postgres requires a postgres:// connection URL');
  return url;
}

export function schemaName(schema: string): string {
  identifier(schema, 'schema name');
  if (/^pg_/i.test(schema))
    throw new TypeError('Schema names starting with pg_ are reserved');
  return schema;
}

// The advisory lock of a schema's DDL, as hashtextextended keys it.
const schemaKey = (schema: string) => `elt:${schema}`;

// Serializes, until the transaction ends, the DDL that makes a schema and the
// objects its loads, views and checkpoints share: Postgres refuses a second
// session's CREATE SCHEMA or CREATE TABLE of the same name with 23505.
export async function lockSchema(
  sql: postgres.ISql,
  schema: string,
): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${schemaKey(schema)}, 0))`;
}

// Makes the schema in a transaction of its own, which begins only once the
// schema's lock is held. A session refreshes its catalog cache when a
// transaction begins and when it locks a relation, not when it takes an
// advisory lock, so a transaction that waited for the lock could still miss
// the schema that the holder made, and its CREATE SCHEMA IF NOT EXISTS would
// fail with 23505. A schema that this session already sees needs no lock; one
// that it misses, also by a stale cache, is made under the lock. sql is a
// session outside any transaction.
export async function makeSchema(
  sql: postgres.Sql,
  schema: string,
): Promise<void> {
  const [made] =
    await sql`SELECT to_regnamespace(${quote(schema)}) IS NOT NULL AS "exists"`;
  if (made?.exists === true) return;
  const key = schemaKey(schema);
  await sql`SELECT pg_advisory_lock(hashtextextended(${key}, 0))`;
  try {
    await sql.begin((transaction) =>
      transaction.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`),
    );
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
  }
}
