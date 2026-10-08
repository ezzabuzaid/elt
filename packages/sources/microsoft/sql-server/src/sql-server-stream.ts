import {
  type CopyConfiguration,
  type ExtractionCoverage,
  type SourceMessage,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import type {
  SqlServerRow,
  SqlServerSession,
  SqlServerTable,
} from '@workspace/sdk-microsoft-sql-server';

import { TableFields, sentence } from './sql-server-fields.ts';

// Rows per page of a resumable read: each page ends in a checkpoint, so a
// read that fails resumes after the last page it committed.
export const pageSize = 10_000;

// How a subclass syncs its table, and says so in the stream's description.
type SyncTraits = {
  readonly supportedSyncModes: readonly SyncMode[];
  readonly sourceDefinedCursor?: true;
  readonly emitsDeletes?: true;
  readonly strategy: string;
};

// One table as a stream. Each way of reading a table is its own subclass:
// the base names the stream after the table, describes its columns, and
// turns rows into records; a subclass declares how it syncs and reads.
export abstract class SqlServerStream {
  readonly table: SqlServerTable;
  readonly fields: TableFields;
  readonly stream: Stream;

  constructor(table: SqlServerTable, traits: SyncTraits) {
    this.table = table;
    this.fields = new TableFields(table);
    const { properties } = this.fields;
    this.stream = new Stream({
      name: `${table.schema}.${table.name}`,
      jsonSchema: {
        type: 'object',
        description: [
          table.description === null
            ? `SQL Server table ${table.quoted}.`
            : sentence(table.description),
          traits.strategy,
          table.unreadable.length > 0
            ? `The login cannot read ${table.unreadable.join(', ')}, which are left out.`
            : undefined,
        ]
          .filter((part) => part !== undefined)
          .join(' '),
        properties,
        required: Object.keys(properties),
      },
      primaryKey: this.fields.primaryKey,
      supportedSyncModes: traits.supportedSyncModes,
      sourceDefinedCursor: traits.sourceDefinedCursor,
      emitsDeletes: traits.emitsDeletes,
    });
  }

  abstract coverage(): ExtractionCoverage;

  // The fields a read carries. A cursor's state records them, since a field
  // the table gains later reaches only rows changed after it unless every row
  // is read again: elt keeps a stream's checkpoint and rows through a change
  // of its fields, and leaves filling them in to the source.
  protected get fieldNames(): readonly string[] {
    return Object.keys(this.fields.properties);
  }

  // Whether this stream carries a field a state was read without.
  protected gained(read: readonly string[]): boolean {
    return this.fieldNames.some((field) => !read.includes(field));
  }

  abstract extract(
    configuration: CopyConfiguration,
    state: unknown,
    session: SqlServerSession,
  ): AsyncIterable<SourceMessage>;

  protected message(row: SqlServerRow): SourceMessage {
    const [data] = validateRecords(
      this.stream,
      [this.fields.record(row)],
      'SQL Server',
    );
    return { stream: this.stream.name, data };
  }

  // Every row as it is now, in one read.
  protected async *everyRow(
    session: SqlServerSession,
  ): AsyncGenerator<SourceMessage> {
    for await (const row of session.rows(this.table)) yield this.message(row);
  }
}
