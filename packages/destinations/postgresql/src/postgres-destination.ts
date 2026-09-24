import { type CopyConfiguration, Destination } from 'elt';
import { identifier, quote } from './identifier.ts';
import { PostgresAppendWriter } from './postgres-append-writer.ts';
import type { PostgresColumn } from './postgres-column.ts';
import { PostgresColumns } from './postgres-columns.ts';
import { PostgresDeduplicatingWriter } from './postgres-deduplicating-writer.ts';
import { PostgresOverwriteWriter } from './postgres-overwrite-writer.ts';
import { PostgresTable } from './postgres-table.ts';
import type { PostgresWriter } from './postgres-writer.ts';

// Loads into one schema of one database. The URL carries credentials, so it
// stays private and out of identity(), which is persisted with checkpoints.
export class PostgresDestination extends Destination<PostgresTable> {
  readonly supportedDestinationSyncModes = Object.freeze([
    'overwrite',
    'append',
    'append_dedup',
    'overwrite_dedup',
  ] as const);
  readonly schema: string;
  readonly #url: string;
  readonly #server: { host: string; port: string; database: string };

  constructor({ url, schema }: { url: string; schema: string }) {
    super();
    const parsed = URL.parse(url);
    if (
      parsed === null ||
      (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    )
      throw new TypeError('Postgres requires a postgres:// connection URL');
    identifier(schema, 'schema name');
    if (/^pg_/i.test(schema))
      throw new TypeError('Schema names starting with pg_ are reserved');
    this.schema = schema;
    this.#url = url;
    this.#server = {
      host: parsed.hostname,
      port: parsed.port,
      database: decodeURIComponent(parsed.pathname.slice(1)),
    };
    Object.freeze(this);
  }

  override identity(target: PostgresTable): string {
    return JSON.stringify({
      type: 'postgres',
      ...this.#server,
      schema: this.schema,
      target,
    });
  }

  override location(target: PostgresTable): string {
    return `${quote(this.schema)}.${target.quotedName}`;
  }

  table(
    name: string,
    configure?: (columns: PostgresColumns) => readonly PostgresColumn[],
  ): PostgresTable {
    return new PostgresTable(name, configure?.(new PostgresColumns()));
  }

  override createWriter(
    configuration: CopyConfiguration,
    target: PostgresTable,
  ): PostgresWriter {
    this.validateConfiguration(configuration, target);
    if (!(target instanceof PostgresTable))
      throw new TypeError('Postgres requires Postgres table targets');
    const table = target.resolve(configuration.stream);
    switch (configuration.destinationSyncMode) {
      case 'append_dedup':
      case 'overwrite_dedup':
        return new PostgresDeduplicatingWriter(
          configuration,
          this.#url,
          this.schema,
          table,
        );
      case 'append':
        return new PostgresAppendWriter(
          configuration.stream,
          this.#url,
          this.schema,
          table,
        );
      case 'overwrite':
        return new PostgresOverwriteWriter(
          configuration.stream,
          this.#url,
          this.schema,
          table,
        );
      default:
        throw new TypeError(
          `Destination does not support ${configuration.destinationSyncMode}`,
        );
    }
  }
}
