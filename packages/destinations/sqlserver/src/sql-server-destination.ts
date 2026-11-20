import {
  type CopyConfiguration,
  Destination,
  type FailureType,
  type Load,
  type PipelineClock,
  parsePosition,
  positionsAfter,
} from '@eltjs/elt';
import { SqlServerDatabase } from '@eltjs/sdk-microsoft-sql-server';

import type { SqlServerColumn } from './sql-server-column.ts';
import { SqlServerColumns } from './sql-server-columns.ts';
import { type SqlServerLogin, connect } from './sql-server-connection.ts';
import { identifiers } from './sql-server-identifiers.ts';
import { SqlServerLoad } from './sql-server-load.ts';
import { readNumbering, sqlServerDatabase } from './sql-server-numbering.ts';
import { SqlServerSetupError } from './sql-server-setup-error.ts';
import { SqlServerTable } from './sql-server-table.ts';
import { SqlServerWriter } from './sql-server-writer.ts';

// Loads into the database of a login: each target is a reader view in marts
// over a raw table in _warehouse, as in elt-postgresql (ADR 0001). The login
// carries credentials, so it stays private and out of location(), which is
// persisted with checkpoints.
export class SqlServerDestination extends Destination<SqlServerTable> {
  readonly supportedDestinationSyncModes = Object.freeze(['append'] as const);
  // How long the history keeps a position readable: 30 days unless set. The
  // destinations of one database share one numbering, so the shortest
  // retention among them decides.
  readonly retention: Temporal.Duration;
  readonly #database: SqlServerDatabase;

  constructor({
    login,
    retention = Temporal.Duration.from({ days: 30 }),
  }: {
    login: SqlServerLogin;
    retention?: Temporal.Duration;
  }) {
    super();
    if (retention.sign < 0)
      throw new RangeError(`Retention ${retention} must not be negative`);
    this.#database = new SqlServerDatabase(login);
    this.retention = retention;
    Object.freeze(this);
  }

  // SQL Server compares names without case, so one raw table has one
  // location.
  override location(target: SqlServerTable): string {
    return identifiers.key(target.raw);
  }

  // One connection for the whole run; each commit is its own transaction,
  // numbered in the numbering that the destinations of the database share.
  override async load(owner: {
    clock: PipelineClock;
    connection: string;
  }): Promise<Load<SqlServerTable>> {
    const load = await SqlServerLoad.open(
      this.#database,
      { connector: owner.connection },
      { clock: owner.clock, retention: this.retention },
    );
    return {
      prepare: (configuration, target, binding) =>
        this.createWriter(configuration, target).prepare(load, binding),
      [Symbol.asyncDispose]: () => load[Symbol.asyncDispose](),
    };
  }

  // A database that is not set up as the destination needs it is config,
  // because a person must change it; every other error is system.
  override failureType(error: unknown): FailureType {
    return error instanceof SqlServerSetupError ? 'config' : 'system';
  }

  // The positions of the database after a position, ascending, or all of
  // them; each one, `${epoch}:${number}`, names a commit where no pass of the
  // database is half read. A position of another epoch, or past the newest
  // commit, is expired.
  async positions(
    after?: string,
  ): Promise<readonly string[] | { readonly expired: string }> {
    const since =
      after === undefined ? undefined : parsePosition(after, sqlServerDatabase);
    await using connection = await connect(this.#database);
    return positionsAfter(
      await readNumbering(connection),
      since,
      sqlServerDatabase,
    );
  }

  table(
    name: string,
    configure?: (columns: SqlServerColumns) => readonly SqlServerColumn[],
  ): SqlServerTable {
    return new SqlServerTable(name, configure?.(new SqlServerColumns()));
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: SqlServerTable,
  ): SqlServerWriter {
    this.validateConfiguration(configuration, target);
    if (!(target instanceof SqlServerTable))
      throw new TypeError('SQL Server requires SQL Server table targets');
    return new SqlServerWriter(
      configuration,
      this.#database,
      target.resolve(configuration.stream),
      this.retention,
    );
  }
}
