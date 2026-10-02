import { randomUUID } from 'node:crypto';

import spawn from 'nano-spawn';

import {
  checkDockerAvailable,
  createContainer,
  findRunningContainer,
} from './container.ts';

export interface MysqlContainerConfig {
  name?: string;
  image?: string;
  password?: string;
  database?: string;
  user?: string;
}

export interface MysqlContainer {
  connectionString: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  cleanup: () => Promise<void>;
}

async function execFirstSuccessful(
  containerId: string,
  commandVariants: string[][],
): Promise<void> {
  for (const command of commandVariants) {
    try {
      await spawn('docker', ['exec', containerId, ...command]);
      return;
    } catch {
      // Try the next available client command.
    }
  }

  throw new Error(`No compatible MySQL client command found in ${containerId}`);
}

async function waitForMysql(
  containerId: string,
  user: string,
  password: string,
  maxRetries = 60,
  retryDelayMs = 1000,
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await execFirstSuccessful(containerId, [
        [
          'mysqladmin',
          'ping',
          '-h',
          '127.0.0.1',
          '-u',
          user,
          `--password=${password}`,
          '--silent',
        ],
        [
          'mariadb-admin',
          'ping',
          '-h',
          '127.0.0.1',
          '-u',
          user,
          `--password=${password}`,
          '--silent',
        ],
      ]);

      await execFirstSuccessful(containerId, [
        [
          'mysql',
          '-h',
          '127.0.0.1',
          '-u',
          user,
          `--password=${password}`,
          '-e',
          'SELECT 1',
        ],
        [
          'mariadb',
          '-h',
          '127.0.0.1',
          '-u',
          user,
          `--password=${password}`,
          '-e',
          'SELECT 1',
        ],
      ]);

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw new Error(
    `MySQL-compatible container ${containerId} failed to become ready after ${maxRetries} retries`,
  );
}

async function ensureDatabase(
  containerId: string,
  user: string,
  password: string,
  database: string,
): Promise<void> {
  const statement = `CREATE DATABASE IF NOT EXISTS \`${database.replaceAll('`', '``')}\``;

  await execFirstSuccessful(containerId, [
    [
      'mysql',
      '-h',
      '127.0.0.1',
      '-u',
      user,
      `--password=${password}`,
      '-e',
      statement,
    ],
    [
      'mariadb',
      '-h',
      '127.0.0.1',
      '-u',
      user,
      `--password=${password}`,
      '-e',
      statement,
    ],
  ]);
}

async function startMysqlFamilyContainer(
  dialect: 'mysql' | 'mariadb',
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  const testName = dialect === 'mysql' ? 'MySQL tests' : 'MariaDB tests';
  const dockerAvailable = await checkDockerAvailable(testName);
  if (!dockerAvailable) {
    return undefined;
  }

  const image =
    config?.image ?? (dialect === 'mysql' ? 'mysql:8.4' : 'mariadb:11.8');
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'testdb';
  const user = config?.user ?? 'root';
  const name = config?.name ?? `${dialect}-test-${randomUUID()}`;

  const existing = await findRunningContainer(name, 3306);
  if (existing) {
    return {
      connectionString: `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${existing.port}/${encodeURIComponent(database)}`,
      containerId: existing.containerId,
      host: existing.host,
      port: existing.port,
      user,
      password,
      database,
      cleanup: async () => {},
    };
  }

  const env: Record<string, string> =
    dialect === 'mysql'
      ? {
          MYSQL_ROOT_PASSWORD: password,
          MYSQL_DATABASE: database,
        }
      : {
          MARIADB_ROOT_PASSWORD: password,
          MARIADB_DATABASE: database,
        };

  const container = await createContainer({
    image,
    name,
    env,
    internalPort: 3306,
  });

  try {
    await waitForMysql(container.containerId, user, password);
    await ensureDatabase(container.containerId, user, password, database);

    return {
      connectionString: `mysql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:${container.port}/${encodeURIComponent(database)}`,
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

export async function startMysqlContainer(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  return startMysqlFamilyContainer('mysql', config);
}

export async function startMariadbContainer(
  config?: MysqlContainerConfig,
): Promise<MysqlContainer | undefined> {
  return startMysqlFamilyContainer('mariadb', config);
}

export async function withMysqlContainer<T>(
  fn: (container: MysqlContainer) => Promise<T>,
  config?: MysqlContainerConfig,
): Promise<T | undefined> {
  const container = await startMysqlContainer(config);
  if (!container) {
    return undefined;
  }

  try {
    return await fn(container);
  } finally {
    await container.cleanup();
  }
}

export async function withMariadbContainer<T>(
  fn: (container: MysqlContainer) => Promise<T>,
  config?: MysqlContainerConfig,
): Promise<T | undefined> {
  const container = await startMariadbContainer(config);
  if (!container) {
    return undefined;
  }

  try {
    return await fn(container);
  } finally {
    await container.cleanup();
  }
}
