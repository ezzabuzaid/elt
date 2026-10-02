import spawn from 'nano-spawn';

import {
  checkDockerAvailable,
  createContainer,
  findRunningContainer,
} from './container.ts';

export interface PostgresContainerConfig {
  name?: string;
  image?: string;
  password?: string;
  database?: string;
  user?: string;
}

export interface PostgresContainer {
  connectionString: string;
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  cleanup: () => Promise<void>;
}

async function waitForPostgres(
  containerId: string,
  user: string,
  database: string,
  maxRetries = 30,
  retryDelayMs = 1000,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await spawn('docker', [
        'exec',
        containerId,
        'pg_isready',
        '-U',
        user,
        '-d',
        database,
      ]);

      await spawn('docker', [
        'exec',
        containerId,
        'psql',
        '-U',
        user,
        '-d',
        database,
        '-c',
        'SELECT 1',
      ]);

      return;
    } catch {
      // Not ready yet
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(
    `PostgreSQL container ${containerId} failed to become ready after ${maxRetries} retries`,
  );
}

export async function startPostgresContainer(
  config?: PostgresContainerConfig,
): Promise<PostgresContainer | undefined> {
  const dockerAvailable = await checkDockerAvailable('PostgreSQL tests');
  if (!dockerAvailable) {
    return undefined;
  }

  const image = config?.image ?? 'postgres:17-alpine';
  const password = config?.password ?? 'testpassword';
  const database = config?.database ?? 'testdb';
  const user = config?.user ?? 'postgres';
  const name =
    config?.name ??
    `postgres-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const existing = await findRunningContainer(name, 5432);
  if (existing) {
    return {
      connectionString: `postgresql://${user}:${password}@localhost:${existing.port}/${database}`,
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
      POSTGRES_PASSWORD: password,
      POSTGRES_DB: database,
      POSTGRES_USER: user,
    },
    internalPort: 5432,
  });

  try {
    await waitForPostgres(container.containerId, user, database);

    return {
      connectionString: `postgresql://${user}:${password}@localhost:${container.port}/${database}`,
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

export async function withPostgresContainer<T>(
  fn: (container: PostgresContainer) => Promise<T>,
  config?: PostgresContainerConfig,
): Promise<T | undefined> {
  const container = await startPostgresContainer(config);
  if (!container) {
    return undefined;
  }

  try {
    return await fn(container);
  } finally {
    await container.cleanup();
  }
}
