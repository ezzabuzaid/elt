import {
  type FieldSchema,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import type { ChatDatabase } from '@workspace/sdk-apple-messages';

import type { MessageSelection, MessagesScan } from './messages-scan.ts';

// What the source needs from any Messages stream, whatever its rows.
export type MessagesReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: MessagesScan): AsyncIterable<Record<string, unknown>>;
  file(record: Record<string, unknown>): string | null;
};

// A Messages stream: its description, and how its records come out of a
// run's chat.db snapshot. Reading is the same for every stream: read one row,
// keep it only if the import scope does, project it into records and validate
// each against the schema, then read the next, so a pass holds one row however
// long the history. Streams supply the rows, what the scope keeps and the
// projection.
export abstract class AppleMessagesStream<Row> {
  abstract readonly name: string;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: Readonly<Record<string, FieldSchema>>;
    readonly required: string[];
  };
  abstract readonly primaryKey: readonly string[];
  readonly supportedSyncModes: readonly SyncMode[] = Object.freeze([
    'full_refresh',
    'incremental',
  ]);
  // Every read is the whole store, so incremental copies diff snapshots.
  readonly sourceDefinedCursor = true;
  readonly emitsDeletes = true;
  #stream?: Stream;

  describe(): Stream {
    this.#stream ??= new Stream(this);
    return this.#stream;
  }

  async *read(scan: MessagesScan): AsyncGenerator<Record<string, unknown>> {
    const { selection } = scan;
    for (const row of this.rows(scan.database)) {
      if (selection !== null && !this.accepts(row, selection)) continue;
      for (const record of await this.records(row))
        yield* validateRecords(this, [record], 'Messages');
    }
  }

  // The file a record carries, for streams that support file reads.
  file(_record: Record<string, unknown>): string | null {
    return null;
  }

  protected abstract rows(database: ChatDatabase): Iterable<Row>;

  // Whether an import scope keeps the row.
  protected abstract accepts(row: Row, selection: MessageSelection): boolean;

  protected abstract records(
    row: Row,
  ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
}
