import { randomUUID } from 'node:crypto';

import sql from 'mssql';
import spawn from 'nano-spawn';

import {
  checkDockerAvailable,
  createContainer,
  findRunningContainer,
} from './container.ts';

export const DEFAULT_SQLSERVER_IMAGE =
  'mcr.microsoft.com/mssql/server:2022-latest';

export interface SqlServerContainerConfig {
  name?: string;
  image?: string;
  password?: string;
  database?: string;
}

export interface SqlServerContainer {
  connectionString: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  cleanup: () => Promise<void>;
}

export async function waitForFtsReady(
  connectionString: string,
  maxWaitMs = 10000,
  pollIntervalMs = 100,
): Promise<void> {
  const pool = await sql.connect(connectionString);
  try {
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const result = await pool.request().query(`
        SELECT FULLTEXTCATALOGPROPERTY('context_store_catalog', 'PopulateStatus') as status
      `);
      if (result.recordset[0]?.status === 0) {
        return;
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  } finally {
    await pool.close();
  }
}

async function execSqlCmd(
  containerId: string,
  password: string,
  query: string,
): Promise<void> {
  try {
    await spawn('docker', [
      'exec',
      containerId,
      '/opt/mssql-tools18/bin/sqlcmd',
      '-S',
      'localhost',
      '-U',
      'sa',
      '-P',
      password,
      '-C',
      '-Q',
      query,
    ]);
  } catch {
    await spawn('docker', [
      'exec',
      containerId,
      '/opt/mssql-tools/bin/sqlcmd',
      '-S',
      'localhost',
      '-U',
      'sa',
      '-P',
      password,
      '-Q',
      query,
    ]);
  }
}

async function waitForSqlServer(
  containerId: string,
  password: string,
  maxRetries = 60,
  retryDelayMs = 2000,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await execSqlCmd(containerId, password, 'SELECT 1');
      return;
    } catch {
      // Not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(
    `SQL Server container ${containerId} failed to become ready after ${maxRetries} retries`,
  );
}

async function createDatabase(
  containerId: string,
  password: string,
  database: string,
): Promise<void> {
  await execSqlCmd(
    containerId,
    password,
    `IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = '${database}') CREATE DATABASE [${database}]`,
  );
}

export async function startSqlServerContainer(
  config?: SqlServerContainerConfig,
): Promise<SqlServerContainer | undefined> {
  const dockerAvailable = await checkDockerAvailable('SQL Server tests');
  if (!dockerAvailable) {
    return undefined;
  }

  const image = config?.image ?? DEFAULT_SQLSERVER_IMAGE;
  const password = config?.password ?? 'StrongP@ssw0rd123!';
  const database = config?.database ?? 'testdb';
  const user = 'sa';
  const name = config?.name ?? `sqlserver-test-${randomUUID()}`;

  const existing = await findRunningContainer(name, 1433);
  if (existing) {
    return {
      connectionString: `Server=localhost,${existing.port};Database=${database};User Id=${user};Password=${password};TrustServerCertificate=true;Encrypt=false;`,
      containerId: existing.containerId,
      host: existing.host,
      port: existing.port,
      user,
      password,
      database,
      cleanup: async () => {},
    };
  }

  const container = await createContainer({
    image,
    name,
    env: {
      ACCEPT_EULA: 'Y',
      MSSQL_SA_PASSWORD: password,
    },
    internalPort: 1433,
  });

  try {
    await waitForSqlServer(container.containerId, password);
    await createDatabase(container.containerId, password, database);

    return {
      connectionString: `Server=localhost,${container.port};Database=${database};User Id=${user};Password=${password};TrustServerCertificate=true;Encrypt=false;`,
      containerId: container.containerId,
      host: container.host,
      port: container.port,
      user,
      password,
      database,
      cleanup: config?.name ? async () => {} : container.cleanup,
    };
  } catch (error) {
    await container.cleanup();
    throw error;
  }
}

export async function withSqlServerContainer<T>(
  fn: (container: SqlServerContainer) => Promise<T>,
  config?: SqlServerContainerConfig,
): Promise<T | undefined> {
  const container = await startSqlServerContainer(config);
  if (!container) {
    return undefined;
  }

  try {
    return await fn(container);
  } finally {
    await container.cleanup();
  }
}
