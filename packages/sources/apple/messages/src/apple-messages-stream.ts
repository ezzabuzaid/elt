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
  read(scan: MessagesScan): Promise<Record<string, unknown>[]>;
  file(record: Record<string, unknown>): string | null;
};

// A Messages stream: its description, and how its records come out of a
// run's chat.db snapshot. Reading is the same for every stream: take the rows
// the import scope keeps, project each into records, validate them against
// the schema, so streams supply only those first two steps.
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

  async read(scan: MessagesScan): Promise<Record<string, unknown>[]> {
    const { selection } = scan;
    const rows = this.rows(scan.database).filter(
      (row) => selection === null || this.accepts(row, selection),
    );
    const records = await Promise.all(rows.map((row) => this.records(row)));
    return validateRecords(this, records.flat(), 'Messages');
  }

  // The file a record carries, for streams that support file reads.
  file(_record: Record<string, unknown>): string | null {
    return null;
  }

  protected abstract rows(database: ChatDatabase): readonly Row[];

  // Whether an import scope keeps the row.
  protected abstract accepts(row: Row, selection: MessageSelection): boolean;

  protected abstract records(
    row: Row,
  ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
}
