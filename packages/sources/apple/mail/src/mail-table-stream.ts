import type { MailTable } from '@workspace/sdk-apple-mail';

import {
  AppleMailStream,
  type MailEntry,
  type MailSchema,
  mailSchema,
} from './apple-mail-stream.ts';
import {
  type Meanings,
  fieldName,
  tableProperties,
  tableRecord,
} from './mail-fields.ts';
import type { MailScan } from './mail-scan.ts';

// A stream that copies one Envelope Index table: one record per row, every
// column a field named after it, in the index's column order.
export abstract class MailTableStream<
  T extends MailTable,
> extends AppleMailStream {
  readonly table: T;
  readonly jsonSchema: MailSchema;
  readonly primaryKey: readonly string[];

  constructor(table: T, description: string, meanings: Meanings<T>) {
    super();
    this.table = table;
    this.jsonSchema = mailSchema(
      `${description} Read from the Envelope Index ${table.name} table; index row identifiers are local to this Mac. Relationships name source streams within this source, not destination tables.`,
      tableProperties(table, meanings),
    );
    this.primaryKey = table.keys.map((key) => {
      const kind = table.columns[key];
      if (kind === undefined)
        throw new TypeError(
          `Mail table ${table.name} has no key column ${key}`,
        );
      return fieldName(key, kind);
    });
  }

  protected *entries(scan: MailScan): Generator<MailEntry, void, undefined> {
    for (const row of scan.snapshot.index.rows(this.table))
      yield { data: tableRecord(this.table, row), file: null };
  }
}
