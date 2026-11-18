import postgres from 'postgres';

import {
  type Connection,
  type CopyOutcome,
  type DeclaredCopy,
  type RecordedPass,
  type StreamCheck,
  SyncHistory,
  copyStatus,
  errorMessage,
  passError,
  passFailureType,
  passStatus,
  readerCatalog,
  recordedFailure,
} from '@eltjs/elt';

import { identifier } from './identifier.ts';
import { PostgresDestination } from './postgres-destination.ts';
import { grantReading, installNumbering } from './postgres-numbering.ts';
import { lockSchema } from './postgres-session.ts';
import {
  syncHistoryTables,
  syncHistoryViews,
} from './postgres-sync-history-schema.ts';
import type { PostgresTable } from './postgres-table.ts';
import { type PostgresView, publishPostgresViews } from './postgres-views.ts';

// Lists what readers of marts query, its views, from the comments every load
// and publication writes there. A table in marts, such as the raw table of a
// computed dataset, is not for readers, as in the catalog of elt-sqlite.
const catalog: PostgresView = {
  ...readerCatalog,
  query: `SELECT 'view' AS kind, c.relname::text AS name, NULL::text AS data_type,
      obj_description(c.oid, 'pg_class') AS description
    FROM pg_class c
    WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind = 'v'
    UNION ALL
    SELECT 'column', c.relname || '.' || a.attname,
      format_type(a.atttypid, a.atttypmod), col_description(c.oid, a.attnum)
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind = 'v'
    ORDER BY 2`,
};

// Records every pass in the _warehouse schema, and shows readers that history
// and the catalog through views in marts. Who may read marts is the
// database's own grant. readers are the roles that read the database as of
// a position with their own session, such as an agent's read-only role:
// each install grants them what a reading needs, as dbt applies the grants
// a model declares after each build, so no host names the objects of the
// numbering.
export class PostgresSyncHistory extends SyncHistory<PostgresTable> {
  readonly #url: string;
  readonly #readers: readonly string[];

  constructor({
    url,
    readers = [],
  }: {
    url: string;
    readers?: readonly string[];
  }) {
    super();
    this.#url = url;
    this.#readers = Object.freeze(
      readers.map((role) => identifier(role, 'reader role')),
    );
    Object.freeze(this);
  }

  override validate(connection: Connection<PostgresTable>): void {
    this.#schema(connection);
  }

  protected override async recordChecks(
    connection: Connection<PostgresTable>,
    streamChecks: readonly StreamCheck[],
  ): Promise<void> {
    await this.#write(async (transaction) => {
      for (const { stream, at } of streamChecks)
        await transaction`
          INSERT INTO _warehouse.stream_checks (connector, stream, checked_at)
          VALUES (${connection.name}, ${stream}, ${at})
          ON CONFLICT (connector, stream) DO UPDATE SET checked_at = excluded.checked_at`;
    });
  }

  // Every selected stream is declared before reading, even if it produces no
  // rows or the process dies: an unfinished attempt stays running, never success.
  override async begin(
    connection: Connection<PostgresTable>,
    copies: readonly DeclaredCopy<PostgresTable>[],
    at: Date,
  ): Promise<RecordedPass<PostgresTable>> {
    const schema = this.#schema(connection);
    const id = await this.#write(async (transaction) => {
      const [attempt] = await transaction<{ id: string }[]>`
        INSERT INTO _warehouse.sync_attempts (connector, source, started_at)
        VALUES (${connection.name}, ${connection.source.identity}, ${at}) RETURNING id`;
      if (attempt === undefined)
        throw new Error('Sync attempt was not recorded');
      for (const { copy, coverage } of copies)
        await transaction`
          INSERT INTO _warehouse.extraction_coverage
            (attempt_id, stream, target_schema, target_table, sync_mode,
             destination_sync_mode, description, selection)
          VALUES (${attempt.id}, ${copy.from.name}, ${schema},
            ${copy.to.name}, ${copy.configuration.syncMode},
            ${copy.configuration.destinationSyncMode}, ${coverage.description},
            ${transaction.json(coverage.selection)})`;
      return attempt.id;
    });
    return {
      finish: (outcomes, upstream, ended) =>
        this.#finish(id, outcomes, upstream, ended),
      fail: (error, failureType, ended) =>
        this.#write(async (transaction) => {
          await transaction`
            UPDATE _warehouse.extraction_coverage SET status = 'failed',
              failures = ${transaction.json([recordedFailure({ partition: null, error, failureType })])}
            WHERE attempt_id = ${id}`;
          await transaction`
            UPDATE _warehouse.sync_attempts SET status = 'failed',
              completed_at = ${ended}, error = ${errorMessage(error)},
              failure_type = ${failureType}
            WHERE id = ${id}`;
        }),
    };
  }

  // Creates the history's tables, publishes its views and the catalog, and
  // grants each reader the numbering; safe to repeat.
  override async install(): Promise<void> {
    await this.#connect(async (sql) => {
      if (this.#readers.length > 0) await installNumbering(sql);
      await sql.begin(async (transaction) => {
        // The numbering of the destinations makes _warehouse too, under the
        // same lock.
        await lockSchema(transaction, '_warehouse');
        for (const statement of syncHistoryTables)
          await transaction.unsafe(statement);
        await publishPostgresViews(transaction, {
          schema: 'marts',
          views: [...syncHistoryViews, catalog],
        });
        for (const role of this.#readers) await grantReading(transaction, role);
      });
    });
  }

  #schema({ name, destination }: Connection<PostgresTable>): string {
    if (!(destination instanceof PostgresDestination))
      throw new TypeError(
        `Connection ${name}: Postgres sync history records Postgres destinations only`,
      );
    return destination.schema;
  }

  #finish(
    id: string,
    outcomes: readonly CopyOutcome<PostgresTable>[],
    upstream: ReadonlyMap<string, Date>,
    ended: Date,
  ): Promise<void> {
    return this.#write(async (transaction) => {
      for (const outcome of outcomes)
        await transaction`
          UPDATE _warehouse.extraction_coverage SET
            status = ${copyStatus(outcome)},
            written_count = ${outcome.count}, deleted_count = ${outcome.deleted},
            failures = ${transaction.json(outcome.failures.map(recordedFailure))}
          WHERE attempt_id = ${id} AND stream = ${outcome.copy.from.name}`;
      for (const [stream, at] of upstream)
        await transaction`
          UPDATE _warehouse.extraction_coverage SET upstream_current_as_of = ${at}
          WHERE attempt_id = ${id} AND stream = ${stream}`;
      await transaction`
        UPDATE _warehouse.sync_attempts SET completed_at = ${ended},
          status = ${passStatus(outcomes)}, error = ${passError(outcomes)},
          failure_type = ${passFailureType(outcomes)}
        WHERE id = ${id}`;
    });
  }

  #write<T>(work: (transaction: postgres.TransactionSql) => Promise<T>) {
    return this.#connect((sql) => sql.begin(work));
  }

  async #connect<T>(work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
    const sql = postgres(this.#url, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: 'elt-sync-history' },
    });
    try {
      return await work(sql);
    } finally {
      await sql.end();
    }
  }
}
