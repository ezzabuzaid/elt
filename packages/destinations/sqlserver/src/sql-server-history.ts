import { createHash } from 'node:crypto';

import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import type { EncodedValue } from './sql-server-column.ts';
import { storedColumns } from './sql-server-fit.ts';
import { quote } from './sql-server-identifiers.ts';
import { minValid } from './sql-server-numbering.ts';
import { inWarehouse } from './sql-server-schemas.ts';

// The rows of a target that commits replaced or removed, each with the
// number of the commit that did, as in elt-postgresql. Each column has the
// type of the target's column of the same name; the row number of the target
// is not kept (ADR 0003).
export class TargetHistory {
  readonly name: string;

  constructor(key: string) {
    this.name = `_elt_history_${key}`;
  }

  get qualifiedName(): string {
    return inWarehouse(this.name);
  }

  // Made with the target, with the target's columns, none NOT NULL.
  async create(connection: SqlServerConnection, target: string): Promise<void> {
    const columns = (await storedColumns(connection, { table: target })).filter(
      ({ name }) => name !== '_elt_row',
    );
    await connection.query(
      `IF OBJECT_ID(@history, N'U') IS NULL
       BEGIN
         CREATE TABLE ${this.qualifiedName} (${[...columns.map(({ name, type }) => `${quote(name)} ${type} NULL`), '[replaced_in] bigint NOT NULL'].join(', ')});
         CREATE INDEX ${quote(`${this.name}_replaced`)} ON ${this.qualifiedName} ([replaced_in]);
       END`,
      { history: this.qualifiedName },
    );
  }

  // Deletes the rows that only a reading before min_valid reads, which the
  // retention left, once the history exists.
  async expire(connection: SqlServerConnection): Promise<void> {
    await connection.query(
      `IF OBJECT_ID(@history, N'U') IS NOT NULL DELETE FROM ${this.qualifiedName} WHERE [replaced_in] <= CAST(@kept AS bigint)`,
      {
        history: this.qualifiedName,
        kept: String(await minValid(connection)),
      },
    );
  }
}

// The SHA-256 of the values of a staged row, which names its version, as in
// elt-postgresql: each value that is not null counts with its column's name,
// so a column the stream adds, null in each stored row, makes no new
// version. A string counts as its text, and every other value as the JSON
// that the stage carries.
export function rowHash(
  columns: readonly { readonly name: string }[],
  values: readonly EncodedValue[],
): string {
  const digest = createHash('sha256');
  const add = (tag: string, data: string) => {
    digest.update(`${tag}${Buffer.byteLength(data)}:`);
    digest.update(data);
  };
  columns.forEach((column, index) => {
    const value = values[index];
    if (value === null || value === undefined) return;
    add('c', column.name);
    if (typeof value === 'string') add('t', value);
    else add('j', JSON.stringify(value));
  });
  return digest.digest('hex');
}
