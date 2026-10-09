import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { readSQLite } from '@workspace/elt-sqlite';

// The imports as readers see them: settings.sqlite's selected_connectors view
// and each import's sync_status, opened read-only as $query-apple reads them,
// waiting while a pass commits. The heartbeat gates read through this, never
// through the plugin's writers.

type Selected = {
  connector: string;
  database: string;
  connectionError: string | null;
  connectionFailureType: string | null;
  permissions: string;
};

// A problem the user can fix by giving access carries what to grant.
export type ImportProblem = {
  connector: string;
  problem: string;
  permissions: string | null;
};

export class AppleImports {
  readonly #settings: string;

  constructor(directory: string) {
    this.#settings = join(directory, 'settings.sqlite');
  }

  #selected(): Selected[] {
    if (!existsSync(this.#settings)) return [];
    using settings = readSQLite(this.#settings);
    return settings
      .prepare(
        'SELECT connector, database, connection_error, connection_failure_type, permissions FROM selected_connectors',
      )
      .all()
      .map((row) => ({
        connector: String(row.connector),
        database: String(row.database),
        connectionError:
          row.connection_error === null ? null : String(row.connection_error),
        connectionFailureType:
          row.connection_failure_type === null
            ? null
            : String(row.connection_failure_type),
        permissions: String(row.permissions),
      }));
  }

  // The connector's import file, or null while it is not selected or not yet
  // written.
  database(connector: string): string | null {
    const selected = this.#selected().find(
      (item) => item.connector === connector,
    );
    return selected !== undefined && existsSync(selected.database)
      ? selected.database
      : null;
  }

  // Selected connectors whose import could not start, or whose latest pass
  // failed or loaded only in part.
  problems(): ImportProblem[] {
    return this.#selected().flatMap(
      ({
        connector,
        database,
        connectionError,
        connectionFailureType,
        permissions,
      }) => {
        const failure =
          connectionError === null
            ? passFailure(database)
            : { problem: connectionError, failureType: connectionFailureType };
        return failure === null
          ? []
          : [
              {
                connector,
                problem: failure.problem,
                permissions:
                  failure.failureType === 'config' ? permissions : null,
              },
            ];
      },
    );
  }
}

function passFailure(
  database: string,
): { problem: string; failureType: string } | null {
  if (!existsSync(database)) return null;
  using reader = readSQLite(database);
  const latest = reader
    .prepare('SELECT status, error, failure_type FROM sync_status')
    .get();
  if (latest?.status !== 'failed' && latest?.status !== 'partial') return null;
  return {
    problem: `${String(latest.status)}: ${String(latest.error)}`,
    failureType: String(latest.failure_type),
  };
}
