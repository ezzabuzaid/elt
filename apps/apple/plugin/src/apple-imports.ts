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
  permissions: string;
};

export type ImportProblem = {
  connector: string;
  problem: string;
  permissions: string;
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
        'SELECT connector, database, connection_error, permissions FROM selected_connectors',
      )
      .all()
      .map((row) => ({
        connector: String(row.connector),
        database: String(row.database),
        connectionError:
          row.connection_error === null ? null : String(row.connection_error),
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
      ({ connector, database, connectionError, permissions }) => {
        const problem = connectionError ?? passProblem(database);
        return problem === null ? [] : [{ connector, problem, permissions }];
      },
    );
  }
}

function passProblem(database: string): string | null {
  if (!existsSync(database)) return null;
  using reader = readSQLite(database);
  const latest = reader.prepare('SELECT status, error FROM sync_status').get();
  if (latest?.status !== 'failed' && latest?.status !== 'partial') return null;
  return `${String(latest.status)}: ${String(latest.error)}`;
}
