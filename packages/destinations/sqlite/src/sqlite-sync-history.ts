import { DatabaseSync } from 'node:sqlite';

import { transaction } from '@zukhruf/sqlite-transaction';

import {
  type Connection,
  type CopyOutcome,
  type DeclaredCopy,
  type FailureType,
  type RecordedPass,
  type StreamCheck,
  SyncHistory,
  copyStatus,
  passError,
  passFailureType,
  passStatus,
  recordedFailure,
} from '@workspace/elt';

import { installSQLiteCatalog } from './sqlite-catalog.ts';
import { SQLiteDestination } from './sqlite-destination.ts';
import {
  attempts,
  checks,
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
// shows readers that history, and the catalog, through views there.
export class SQLiteSyncHistory extends SyncHistory<SQLiteTable> {
  readonly #soleWriter: boolean;

  // soleWriter: the caller knows that no other process runs a pass of its
  // connections while this history is in use, such as the leader of a
  // connection's flight.
  constructor(options?: { readonly soleWriter?: boolean }) {
    super();
    this.#soleWriter = options?.soleWriter === true;
    Object.freeze(this);
  }

  override validate(connection: Connection<SQLiteTable>): void {
    this.#path(connection);
  }

  protected override async recordChecks(
    connection: Connection<SQLiteTable>,
    streamChecks: readonly StreamCheck[],
  ): Promise<void> {
    write(this.#path(connection), (database) => {
      const check = database.prepare(
        `INSERT INTO ${checks} ("connector", "stream", "checked_at") VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET "checked_at" = excluded."checked_at"`,
      );
      for (const { stream, at } of streamChecks)
        check.run(connection.name, stream, at.toISOString());
    });
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
      finish: async (outcomes, upstream) =>
        this.#finish(path, id, outcomes, upstream),
      fail: async (error, failureType) =>
        write(path, (database) => fail(database, id, error, failureType)),
    };
  }

  // Brings the history's tables to their declaration and publishes its views
  // and the catalog in each connection's file. Tables another version
  // declared otherwise are replaced, and their history with them. A sole
  // writer then records every pass of its connections that began and never
  // ended as failed: the process running it ended first, so no outcome will
  // come, as Airbyte fails a connection's unfinished jobs before it starts the
  // next. Any other caller leaves them running, since another process may
  // still be running them.
  override async install(
    connections: readonly Connection<SQLiteTable>[],
  ): Promise<void> {
    for (const path of new Set(connections.map((each) => this.#path(each)))) {
      write(path, (database) => {
        syncHistoryTables.apply(database);
        publishSQLiteViews(database, { views: syncHistoryViews });
      });
      installSQLiteCatalog({ path });
    }
    if (this.#soleWriter)
      for (const connection of connections) this.#failUnfinished(connection);
  }

  #failUnfinished(connection: Connection<SQLiteTable>): void {
    const error = new Error(
      'The process running this pass ended before the pass did',
    );
    write(this.#path(connection), (database) => {
      const unfinished = database
        .prepare(
          `SELECT "id" FROM ${attempts} WHERE "connector" = ? AND "status" = 'running'`,
        )
        .all(connection.name);
      for (const { id } of unfinished)
        fail(database, Number(id), error, 'system');
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
    upstream: ReadonlyMap<string, Date>,
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
          JSON.stringify(outcome.failures.map(recordedFailure)),
          id,
          outcome.copy.from.name,
        );
      const bound = database.prepare(
        `UPDATE ${coverage} SET "upstream_current_as_of" = ? WHERE "attempt_id" = ? AND "stream" = ?`,
      );
      for (const [stream, at] of upstream)
        bound.run(at.toISOString(), id, stream);
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

// A pass that produced no outcomes, so what it committed is unknown.
function fail(
  database: DatabaseSync,
  id: number,
  error: unknown,
  failureType: FailureType,
): void {
  database
    .prepare(
      `UPDATE ${coverage} SET "status" = 'failed', "failures" = ? WHERE "attempt_id" = ?`,
    )
    .run(
      JSON.stringify([
        recordedFailure({ partition: null, error, failureType }),
      ]),
      id,
    );
  database
    .prepare(
      `UPDATE ${attempts} SET "status" = 'failed', "completed_at" = ${now}, "error" = ?, "failure_type" = ? WHERE "id" = ?`,
    )
    .run(message(error), failureType, id);
}

function persistent({ path }: SQLiteDestination): string {
  if (path === ':memory:')
    throw new TypeError('SQLite sync history requires a destination file');
  return path;
}

function write<T>(
  path: string,
  work: (database: DatabaseSync) => T extends PromiseLike<unknown> ? never : T,
): T {
  using database = new DatabaseSync(path, { timeout: busyTimeout });
  return transaction(database, () => work(database), { mode: 'immediate' });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
