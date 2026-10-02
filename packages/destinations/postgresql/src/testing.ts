import { randomUUID } from 'node:crypto';

import postgres from 'postgres';

const server =
  process.env.TEST_DATABASE_URL ??
  'postgres://postgres:postgres@127.0.0.1:55432/postgres';

/**
 * A database of its own for one test, dropped when the test ends. `sql` is an
 * administrator session there; `as` names the same database for another role.
 */
export async function scratchDatabase(
  options?: postgres.Options<Record<string, postgres.PostgresType>>,
) {
  const admin = postgres(server, { max: 1, onnotice: () => {} });
  const name = `elt_test_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } catch (cause) {
    await admin.end();
    throw new Error(
      `Test Postgres at ${new URL(server).host} is unavailable. Start it with: npx nx run infra:up`,
      { cause },
    );
  }
  const url = new URL(server);
  url.pathname = `/${name}`;
  const as = (username: string, password: string) => {
    const role = new URL(url);
    role.username = username;
    role.password = password;
    return role.href;
  };
  const sql = postgres(url.href, { max: 2, onnotice: () => {}, ...options });
  return {
    name,
    url: url.href,
    sql,
    as,
    async [Symbol.asyncDispose]() {
      await sql.end();
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

/**
 * A scratch database provisioned as infra/init provisions the warehouse: the
 * warehouse role owns it and `contract` (marts/contract.sql) decides what
 * agent_reader sees. `url` loads as the warehouse role; `agent` reads as
 * agent_reader.
 */
export async function scratchWarehouse(contract: string) {
  const database = await scratchDatabase();
  const agent = postgres(database.as('agent_reader', 'agent'), {
    max: 1,
    onnotice: () => {},
  });
  try {
    await database.sql.unsafe(
      `ALTER DATABASE "${database.name}" OWNER TO warehouse`,
    );
    await database.sql.unsafe(contract);
  } catch (error) {
    await agent.end();
    await database[Symbol.asyncDispose]();
    throw error;
  }
  return {
    url: database.as('warehouse', 'warehouse'),
    sql: database.sql,
    agent,
    async [Symbol.asyncDispose]() {
      await agent.end();
      await database[Symbol.asyncDispose]();
    },
  };
}
