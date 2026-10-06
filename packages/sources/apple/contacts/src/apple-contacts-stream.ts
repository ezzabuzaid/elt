import {
  type FieldSchema,
  Stream,
  type SyncMode,
  validateRecords,
} from '@workspace/elt';
import type { AddressBookStore } from '@workspace/sdk-apple-contacts';

import type { ContactSelection, ContactsScan } from './contacts-scan.ts';

// What the source needs from any Contacts stream, whatever its rows.
export type ContactsReader = {
  readonly name: string;
  describe(): Stream;
  read(scan: ContactsScan): Promise<Record<string, unknown>[]>;
};

// A Contacts stream: its description, and how its records come out of every
// account store. Reading is the same for every stream: each store's rows the
// container selection keeps, each projected into records whose fields follow
// the schema's order, then validated, so streams supply only those steps.
export abstract class AppleContactsStream<Row> {
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

  // One row at a time, so an image's bytes are hashed one file after another.
  async read(scan: ContactsScan): Promise<Record<string, unknown>[]> {
    const fields = Object.keys(this.jsonSchema.properties);
    const records: Record<string, unknown>[] = [];
    for (const store of scan.stores) {
      const selection = scan.selection(store);
      for (const row of this.rows(store)) {
        if (selection !== null && !this.accepts(row, selection)) continue;
        for (const values of await this.records(row, store, scan))
          records.push(
            Object.fromEntries(
              fields.map((field) => [field, values[field] ?? null]),
            ),
          );
      }
    }
    return validateRecords(this, records, 'Contacts');
  }

  protected abstract rows(store: AddressBookStore): readonly Row[];

  // Whether a container selection keeps the row.
  protected abstract accepts(row: Row, selection: ContactSelection): boolean;

  // A row's fields by name; read() orders them as the schema lists them.
  protected abstract records(
    row: Row,
    store: AddressBookStore,
    scan: ContactsScan,
  ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
}
