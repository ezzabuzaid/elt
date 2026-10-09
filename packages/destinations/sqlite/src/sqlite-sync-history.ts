import { DatabaseSync } from 'node:sqlite';

import {
  type Connection,
  type CopyOutcome,
  type DeclaredCopy,
  type RecordedPass,
  SyncHistory,
  copyStatus,
  passError,
  passFailureType,
  passStatus,
} from '@workspace/elt';

import { SQLiteDestination } from './sqlite-destination.ts';
import {
  attempts,
  coverage,
  now,
  syncHistoryTables,
  syncHistoryViews,
} from './sqlite-sync-history-schema.ts';
import type { SQLiteTable } from './sqlite-table.ts';
import { publishSQLiteViews } from './sqlite-views.ts';

// How long a history write waits for a load or reader to finish committing.
const busyTimeout = 30_000;

// Records every pass in the file its connection loads, beside the data, and
// shows readers that history through views there. Run install() with every
// destination before the pipeline records its first pass.
export class SQLiteSyncHistory extends SyncHistory<SQLiteTable> {
  constructor() {
    super();
    Object.freeze(this);
  }

  override validate(connection: Connection<SQLiteTable>): void {
    this.#path(connection);
  }

  // Every selected stream is declared before reading, even if it produces no
  // rows or the process dies: an unfinished attempt stays running, never success.
  override async begin(
    connection: Connection<SQLiteTable>,
    copies: readonly DeclaredCopy<SQLiteTable>[],
  ): Promise<RecordedPass<SQLiteTable>> {
    const path = this.#path(connection);
    const id = write(path, (database) => {
      const attempt = database
        .prepare(
          `INSERT INTO ${attempts} ("connector", "source", "started_at") VALUES (?, ?, ${now}) RETURNING "id"`,
        )
        .get(connection.name, connection.source.identity);
      if (attempt === undefined)
        throw new Error('Sync attempt was not recorded');
      const id = Number(attempt.id);
      const declare = database.prepare(
        `INSERT INTO ${coverage} ("attempt_id", "stream", "target_schema", "target_table", "sync_mode", "destination_sync_mode", "description", "selection") VALUES (?, ?, 'main', ?, ?, ?, ?, ?)`,
      );
      for (const { copy, coverage } of copies)
        declare.run(
          id,
          copy.from.name,
          copy.to.name,
          copy.configuration.syncMode,
          copy.configuration.destinationSyncMode,
          coverage.description,
          JSON.stringify(coverage.selection),
        );
      return id;
    });
    return {
      finish: async (outcomes) => this.#finish(path, id, outcomes),
      fail: async (error, failureType) =>
        write(path, (database) => {
          database
            .prepare(
              `UPDATE ${coverage} SET "status" = 'failed', "failures" = ? WHERE "attempt_id" = ?`,
            )
            .run(
              JSON.stringify([
                {
                  partition: null,
                  error: message(error),
                  failure_type: failureType,
                },
              ]),
              id,
            );
          database
            .prepare(
              `UPDATE ${attempts} SET "status" = 'failed', "completed_at" = ${now}, "error" = ?, "failure_type" = ? WHERE "id" = ?`,
            )
            .run(message(error), failureType, id);
        }),
    };
  }

  // Creates the history's tables and publishes its views in each file; safe
  // to repeat.
  async install(destinations: Iterable<SQLiteDestination>): Promise<void> {
    for (const destination of destinations)
      write(persistent(destination), (database) => {
        for (const statement of syncHistoryTables) database.exec(statement);
        publishSQLiteViews(database, { views: syncHistoryViews });
      });
  }

  #path({ name, destination }: Connection<SQLiteTable>): string {
    if (!(destination instanceof SQLiteDestination))
      throw new TypeError(
        `Connection ${name}: SQLite sync history records SQLite destinations only`,
      );
    return persistent(destination);
  }

  #finish(
    path: string,
    id: number,
    outcomes: readonly CopyOutcome<SQLiteTable>[],
  ): void {
    write(path, (database) => {
      const record = database.prepare(
        `UPDATE ${coverage} SET "status" = ?, "written_count" = ?, "deleted_count" = ?, "failures" = ? WHERE "attempt_id" = ? AND "stream" = ?`,
      );
      for (const outcome of outcomes)
        record.run(
          copyStatus(outcome),
          outcome.count,
          outcome.deleted,
          JSON.stringify(
            outcome.failures.map(({ partition, error, failureType }) => ({
              partition,
              error: message(error),
              failure_type: failureType,
            })),
          ),
          id,
          outcome.copy.from.name,
        );
      database
        .prepare(
          `UPDATE ${attempts} SET "completed_at" = ${now}, "status" = ?, "error" = ?, "failure_type" = ? WHERE "id" = ?`,
        )
        .run(
          passStatus(outcomes),
          passError(outcomes),
          passFailureType(outcomes),
          id,
        );
    });
  }
}

function persistent({ path }: SQLiteDestination): string {
  if (path === ':memory:')
    throw new TypeError('SQLite sync history requires a destination file');
  return path;
}

function write<T>(path: string, work: (database: DatabaseSync) => T): T {
  using database = new DatabaseSync(path, { timeout: busyTimeout });
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work(database);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
