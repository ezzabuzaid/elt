import {
  type FieldSchema,
  type SchemaRecord,
  Stream,
  type SyncMode,
  validateRecords,
} from 'elt';
import { eventKitFields } from '../eventkit-schema.ts';
import type { NotesScan } from './notes-scan.ts';

type Properties = Readonly<Record<string, FieldSchema>>;

export const notesFields = {
  ...eventKitFields,
  nullableId: { type: ['string', 'null'], minLength: 1 },
  nullableNumber: { type: ['number', 'null'] },
} as const;

// Every Notes property is required; the record type follows from the schema.
export function notesSchema<P extends Properties>(properties: P) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
  } as const;
}

// What the source needs from any Notes stream, whatever its record type.
export type NotesReader = {
  describe(): Stream;
  read(scan: NotesScan): Promise<Record<string, unknown>[]>;
  file(record: Record<string, unknown>, scan: NotesScan): string | null;
};

// A Notes stream: its description, and how its records come out of a run's
// scan. Reading is the same for every stream — pick the rows, project each,
// validate against the schema — so streams supply only those two steps.
// Public discovery returns only the Stream description.
export abstract class AppleNotesStream<P extends Properties, Row> {
  abstract readonly name: string;
  abstract readonly jsonSchema: ReturnType<typeof notesSchema<P>>;
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

  async read(scan: NotesScan): Promise<SchemaRecord<P>[]> {
    const records = await Promise.all(
      this.rows(scan).map((row) => this.record(row, scan)),
    );
    return validateRecords(
      this.describe(),
      records,
      'Notes',
    ) as SchemaRecord<P>[];
  }

  // The file a record carries, for streams that support file reads.
  file(_record: SchemaRecord<P>, _scan: NotesScan): string | null {
    return null;
  }

  protected abstract rows(scan: NotesScan): readonly Row[];

  protected abstract record(
    row: Row,
    scan: NotesScan,
  ): SchemaRecord<P> | Promise<SchemaRecord<P>>;
}
