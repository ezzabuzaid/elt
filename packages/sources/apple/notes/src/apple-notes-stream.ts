import {
  type Properties,
  type RecordDraft,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import type { NotesScan } from './notes-scan.ts';

export const notesFields = {
  ...eventKitFields,
  nullableId: { type: ['string', 'null'], minLength: 1 },
  nullableNumber: { type: ['number', 'null'] },
} as const;

// What the source needs from any Notes stream, whatever its record type.
export type NotesReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: NotesScan): AsyncIterable<Record<string, unknown>>;
  file(record: Record<string, unknown>, scan: NotesScan): string | null;
};

// A Notes stream: its description, and how its records come out of a run's
// scan. Reading is the same for every stream — read one row, project it,
// validate it against the schema, then read the next, so a pass holds one
// row however large the store — so streams supply only the rows and the
// projection.
// Public discovery returns only the Stream description.
export abstract class AppleNotesStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly jsonSchema: {
    readonly type: 'object';
    readonly description: string;
    readonly properties: P;
    readonly required: string[];
  };
  readonly primaryKey: readonly string[] = ['id'];
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

  async *read(scan: NotesScan): AsyncGenerator<SchemaRecord<P>> {
    for (const row of this.rows(scan))
      yield* validateRecords(this, [await this.record(row, scan)], 'Notes');
  }

  // The file a record carries, for streams that support file reads.
  file(_record: SchemaRecord<P>, _scan: NotesScan): string | null {
    return null;
  }

  protected abstract rows(scan: NotesScan): Iterable<Row>;

  protected abstract record(
    row: Row,
    scan: NotesScan,
  ): RecordDraft<P> | Promise<RecordDraft<P>>;
}
