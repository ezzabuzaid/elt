import postgres from 'postgres';

import {
  type Connection,
  type CopyOutcome,
  type DeclaredCopy,
  type RecordedPass,
  type StreamCheck,
  SyncHistory,
  copyStatus,
  passError,
  passFailureType,
  passStatus,
  readerCatalog,
  recordedFailure,
} from '@workspace/elt';

import { PostgresDestination } from './postgres-destination.ts';
import {
  syncHistoryTables,
  syncHistoryViews,
} from './postgres-sync-history-schema.ts';
import type { PostgresTable } from './postgres-table.ts';
import { type PostgresView, publishPostgresViews } from './postgres-views.ts';

// Lists what readers of marts can query, from the comments every load and
// publication writes there.
const catalog: PostgresView = {
  ...readerCatalog,
  query: `SELECT CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind,
      c.relname::text AS name, NULL::text AS data_type,
      obj_description(c.oid, 'pg_class') AS description
    FROM pg_class c
    WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind IN ('v', 'r')
    UNION ALL
    SELECT 'column', c.relname || '.' || a.attname,
      format_type(a.atttypid, a.atttypmod), col_description(c.oid, a.attnum)
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE c.relnamespace = 'marts'::regnamespace AND c.relkind IN ('v', 'r')
    ORDER BY 2`,
};

// Records every pass in the _warehouse schema, and shows readers that history
// and the catalog through views in marts. Who may read marts is the
// database's own grant.
export class PostgresSyncHistory extends SyncHistory<PostgresTable> {
  readonly #url: string;

  constructor({ url }: { url: string }) {
    super();
    this.#url = url;
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
  ): Promise<RecordedPass<PostgresTable>> {
    const schema = this.#schema(connection);
    const id = await this.#write(async (transaction) => {
      const [attempt] = await transaction<{ id: string }[]>`
        INSERT INTO _warehouse.sync_attempts (connector, source)
        VALUES (${connection.name}, ${connection.source.identity}) RETURNING id`;
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
      finish: (outcomes, upstream) => this.#finish(id, outcomes, upstream),
      fail: (error, failureType) =>
        this.#write(async (transaction) => {
          await transaction`
            UPDATE _warehouse.extraction_coverage SET status = 'failed',
              failures = ${transaction.json([recordedFailure({ partition: null, error, failureType })])}
            WHERE attempt_id = ${id}`;
          await transaction`
            UPDATE _warehouse.sync_attempts SET status = 'failed',
              completed_at = clock_timestamp(), error = ${message(error)},
              failure_type = ${failureType}
            WHERE id = ${id}`;
        }),
    };
  }

  // Creates the history's tables and publishes its views and the catalog;
  // safe to repeat.
  override async install(): Promise<void> {
    await this.#write(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended('elt:sync-history', 0))`;
      for (const statement of syncHistoryTables)
        await transaction.unsafe(statement);
      await publishPostgresViews(transaction, {
        schema: 'marts',
        views: [...syncHistoryViews, catalog],
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
        UPDATE _warehouse.sync_attempts SET completed_at = clock_timestamp(),
          status = ${passStatus(outcomes)}, error = ${passError(outcomes)},
          failure_type = ${passFailureType(outcomes)}
        WHERE id = ${id}`;
    });
  }

  async #write<T>(work: (transaction: postgres.TransactionSql) => Promise<T>) {
    const sql = postgres(this.#url, {
      max: 1,
      onnotice: () => {},
      connection: { application_name: 'elt-sync-history' },
    });
    try {
      return await sql.begin(work);
    } finally {
      await sql.end();
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
