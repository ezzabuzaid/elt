import type { SQLOutputValue } from 'node:sqlite';

import { AppDatabase } from '@workspace/sdk-apple-app-database';

import { MailLayoutError, MailUnavailableError } from './errors.ts';
import {
  type MailColumnKind,
  type MailTable,
  envelopeTables,
} from './mail-tables.ts';

// A value as SQLite stores it in a column the index does not constrain.
export type MailStoredValue = string | number | Uint8Array | null;

// What rows() reads from a column of each kind; a key is never NULL.
type KindValue<
  Kind extends MailColumnKind,
  Key extends boolean,
> = Kind extends 'id'
  ? Key extends true
    ? string
    : string | null
  : Kind extends 'time'
    ? Date | null
    : MailStoredValue;

// One row of a table, keyed by its index column names.
type MailRow<T extends MailTable> = {
  readonly [Column in keyof T['columns']]: KindValue<
    T['columns'][Column],
    Column extends T['keys'][number] ? true : false
  >;
};

// An attachment the index records for a message, which can exist before the
// message file or the attachment file is downloaded.
export type IndexedAttachment = {
  readonly message: string;
  // The MIME part number, such as 2 or 1.2, as the index stores it.
  readonly attachmentId: MailStoredValue;
  readonly name: MailStoredValue;
};

const required = Object.fromEntries(
  envelopeTables.map((table) => [table.name, Object.keys(table.columns)]),
);

// An id is cast to text in SQL, since node:sqlite refuses integers beyond
// 2^53; a time is converted there too.
function expression(column: string, kind: MailColumnKind): string {
  if (kind === 'id') return `CAST("${column}" AS TEXT)`;
  if (kind === 'time')
    return `strftime('%Y-%m-%dT%H:%M:%fZ', "${column}", 'unixepoch')`;
  return `"${column}"`;
}

// Ordered by qualified keys: SQLite would otherwise sort a key by the result
// column that shares its name, the text copy, so 10 before 2.
const select = ({ name, keys, columns }: MailTable) =>
  `SELECT ${Object.entries(columns)
    .map(([column, kind]) => `${expression(column, kind)} AS "${column}"`)
    .join(
      ', ',
    )} FROM "${name}" ORDER BY ${keys.map((key) => `"${name}"."${key}"`).join(', ')}`;

function stored(value: SQLOutputValue | undefined): MailStoredValue {
  if (value === undefined || typeof value === 'bigint')
    throw new TypeError('The Mail index returned an unreadable value');
  return value;
}

// strftime writes a year before 0 with a sign and three digits, which Date
// does not parse; ISO 8601 spells it with six.
const mailDate = (text: string) =>
  new Date(
    text.replace(/^-(\d+)/, (_, year: string) => `-${year.padStart(6, '0')}`),
  );

const read = (kind: MailColumnKind, value: SQLOutputValue | undefined) =>
  kind === 'time' && typeof value === 'string' ? mailDate(value) : value;

function isRow<T extends MailTable>(
  table: T,
  row: Readonly<Record<string, unknown>>,
): row is MailRow<T> {
  return Object.entries(table.columns).every(([column, kind]) => {
    const value = row[column];
    if (kind === 'id')
      return (
        typeof value === 'string' ||
        (value === null && !table.keys.includes(column))
      );
    if (kind === 'time') return value === null || value instanceof Date;
    return (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      value instanceof Uint8Array
    );
  });
}

// Mail's Envelope Index pinned to one moment by a read transaction, its
// layout checked when it opens. Every read streams its rows.
export class EnvelopeIndex implements Disposable {
  readonly #database: AppDatabase;

  constructor(path: string) {
    this.#database = new AppDatabase(path, MailUnavailableError);
    this.#database.requireColumns(required, MailLayoutError);
  }

  *rows<T extends MailTable>(table: T): Generator<MailRow<T>, void, undefined> {
    for (const values of this.#database.iterate(select(table))) {
      const row = Object.fromEntries(
        Object.entries(table.columns).map(([column, kind]) => [
          column,
          read(kind, values[column]),
        ]),
      );
      if (!isRow(table, row))
        throw new TypeError(
          `The Mail index returned an unreadable ${table.name} row`,
        );
      yield row;
    }
  }

  // Every message's ROWID, as decimal text, in index order.
  *messageIds(): Generator<string, void, undefined> {
    for (const { id } of this.#database.iterate(
      'SELECT CAST(ROWID AS TEXT) AS id FROM messages ORDER BY ROWID',
    ))
      // CAST of ROWID, which is never NULL.
      yield String(id);
  }

  *indexedAttachments(): Generator<IndexedAttachment, void, undefined> {
    for (const row of this.#database.iterate(
      'SELECT CAST(message AS TEXT) AS message, attachment_id, name FROM attachments ORDER BY ROWID',
    ))
      yield {
        // CAST of attachments.message, which the index declares NOT NULL.
        message: String(row.message),
        attachmentId: stored(row.attachment_id),
        name: stored(row.name),
      };
  }

  // Each mailbox's URL, whose host names its account.
  *mailboxUrls(): Generator<MailStoredValue, void, undefined> {
    for (const { url } of this.#database.iterate(
      'SELECT url FROM mailboxes ORDER BY ROWID',
    ))
      yield stored(url);
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }
}
