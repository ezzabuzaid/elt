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

  // Takes the shape of table, the target as a change of shape leaves it or
  // the table that is to replace it: each column that table adds enters,
  // nullable, a column that table drops stays, and a column that a widening
  // changes takes the new type, which keeps each value. The history holds
  // one type for each column, so when table changes the type of one it keeps
  // in another way, it drops itself and gives 'retyped': the caller then
  // expires each position before the change, which only its rows read.
  async follow(
    connection: SqlServerConnection,
    table: string,
  ): Promise<'follows' | 'retyped'> {
    const kept = new Map(
      (await storedColumns(connection, { table: this.qualifiedName })).map(
        ({ name, type }) => [name, type],
      ),
    );
    if (kept.size === 0) return 'follows';
    const next = (await storedColumns(connection, { table })).filter(
      ({ name }) => name !== '_elt_row',
    );
    const changed = next.filter(({ name, type }) => {
      const had = kept.get(name);
      return had !== undefined && had !== type;
    });
    if (
      changed.some(({ name, type }) => !widens(String(kept.get(name)), type))
    ) {
      await connection.query(`DROP TABLE ${this.qualifiedName}`);
      return 'retyped';
    }
    for (const { name, type } of changed)
      await connection.query(
        `ALTER TABLE ${this.qualifiedName} ALTER COLUMN ${quote(name)} ${type} NULL`,
      );
    const added = next.filter(({ name }) => !kept.has(name));
    if (added.length > 0)
      await connection.query(
        `ALTER TABLE ${this.qualifiedName} ADD ${added.map(({ name, type }) => `${quote(name)} ${type} NULL`).join(', ')}`,
      );
    return 'follows';
  }

  // Runs changes, a statement that changes or removes rows of target and
  // outputs deleted.*, and keeps each row it output that target stored, as
  // replaced in commit replacedIn, in the same statement (ADR 0005). An
  // insert outputs a deleted row of nulls, which it does not keep. Gives how
  // many rows it kept.
  async keep(
    connection: SqlServerConnection,
    replacedIn: number,
    target: string,
    changes: string,
    params: Readonly<Record<string, string>>,
  ): Promise<number> {
    const columns = (await storedColumns(connection, { table: target }))
      .filter(({ name }) => name !== '_elt_row')
      .map(({ name }) => quote(name));
    const [kept] = await connection.query(
      `INSERT INTO ${this.qualifiedName} (${[...columns, '[replaced_in]'].join(', ')})
       SELECT ${[...columns.map((column) => `[_elt_old].${column}`), 'CAST(@replacedIn AS bigint)'].join(', ')}
       FROM (${changes}) AS [_elt_old] WHERE [_elt_old].[committed_in] IS NOT NULL;
       SELECT @@ROWCOUNT AS [kept];`,
      { ...params, replacedIn: String(replacedIn) },
    );
    return Number(kept?.kept);
  }

  // Deletes the rows of target that where selects, in commit replacedIn, and
  // keeps them in the same statement. where is a condition over the columns
  // of target. Gives how many rows it kept.
  remove(
    connection: SqlServerConnection,
    replacedIn: number,
    target: string,
    where: string,
    params: Readonly<Record<string, string>>,
  ): Promise<number> {
    return this.keep(
      connection,
      replacedIn,
      target,
      `DELETE FROM ${target} OUTPUT deleted.* WHERE ${where}`,
      params,
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

// Whether ALTER COLUMN from type from to type to maps each old value to one
// value of the new type exactly, with no loss: a widening, as in
// elt-postgresql, with the types that SQL Server declares and converts.
// Text keeps the exact form of a number, a bit, a date, a time and a
// decimal, but not of a float, whose conversion keeps 6 digits, nor of
// bytes or JSON. A bigint fits a decimal with 19 digits before its point, a
// date a datetime2, a time more digits of its fraction, and a decimal more
// digits on each side of its point. bigint does not widen to float: past
// 2^53 it loses digits.
function widens(from: string, to: string): boolean {
  const [was, now] = [typeOf(from), typeOf(to)];
  if (to === 'nvarchar(max)')
    return [
      'bigint',
      'bit',
      'date',
      'decimal',
      'datetime2',
      'datetimeoffset',
      'time',
    ].includes(was.name);
  if (was.name === 'bigint' && now.name === 'decimal')
    return now.precision - now.scale >= 19;
  if (was.name === 'date' && now.name === 'datetime2') return true;
  if (was.name !== now.name) return false;
  if (was.name === 'decimal')
    return (
      now.scale >= was.scale &&
      now.precision - now.scale >= was.precision - was.scale
    );
  return (
    ['datetime2', 'datetimeoffset', 'time'].includes(was.name) &&
    now.precision > was.precision
  );
}

// A type as SQL Server spells it in sys.columns: its name, and its
// precision and scale, or its fraction digits as its precision.
function typeOf(type: string) {
  const [, name = type, precision = '0', scale = '0'] =
    /^(\w+)(?:\((\d+)(?:,(\d+))?\))?$/.exec(type) ?? [];
  return { name, precision: Number(precision), scale: Number(scale) };
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
