import postgres from 'postgres';
import { identifier } from './identifier.ts';

// One session, closed however the work using it ends.
export class Connection implements AsyncDisposable {
  readonly sql: postgres.Sql;

  constructor(url: string, applicationName: string) {
    this.sql = postgres(url, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: applicationName },
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

// The server a URL names, without its credentials.
export function server(url: string): {
  host: string;
  port: string;
  database: string;
} {
  const parsed = URL.parse(url);
  if (
    parsed === null ||
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
  )
    throw new TypeError('Postgres requires a postgres:// connection URL');
  return {
    host: parsed.hostname,
    port: parsed.port,
    database: decodeURIComponent(parsed.pathname.slice(1)),
  };
}

export function schemaName(schema: string): string {
  identifier(schema, 'schema name');
  if (/^pg_/i.test(schema))
    throw new TypeError('Schema names starting with pg_ are reserved');
  return schema;
}

// Serializes everything elt writes into one schema: loads, owners, DDL.
export function schemaLock(schema: string): string {
  return `mac-elt:${schema}`;
}
