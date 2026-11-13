import { createHash } from 'node:crypto';

import type postgres from 'postgres';

import { quote } from './identifier.ts';
import type { EncodedValue } from './postgres-column.ts';
import { storedColumns } from './postgres-fit.ts';
import { expireBefore, minValid } from './postgres-numbering.ts';

// A session, or a transaction of one, such as a clear's.
type Queries = Pick<postgres.Sql, 'unsafe'>;

export const version = '"_elt_row_hash"';

// The rows of a target that commits replaced or removed, each with the
// number of the commit that did, as a SQL Server temporal table keeps them
// beside its current table. Each column has the type of the target's column
// of the same name, and changes its type when the target's does; a column
// that the target drops stays, with its last type.
export class TargetHistory {
  readonly schema: string;
  readonly name: string;

  constructor(schema: string, key: string) {
    this.schema = schema;
    this.name = `_elt_history_${key}`;
  }

  get qualifiedName(): string {
    return `${quote(this.schema)}.${quote(this.name)}`;
  }

  // Made with the target, with the target's columns, none NOT NULL: a
  // column that the target drops is NULL in each row kept after. A history
  // that exists follows the target; change gives the number of the commit
  // that changes the target's shape.
  async create(
    sql: Queries,
    target: string,
    change: () => Promise<number>,
  ): Promise<void> {
    const columns = await storedColumns(sql, target);
    await sql.unsafe(
      `CREATE TABLE IF NOT EXISTS ${this.qualifiedName} (${[...columns.map(({ name, type }) => `${quote(name)} ${type}`), '"replaced_in" INTEGER NOT NULL'].join(', ')})`,
    );
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS ${quote(`${this.name}_replaced`)} ON ${this.qualifiedName} ("replaced_in")`,
    );
    await this.#follow(sql, target, change);
  }

  // Takes each column of the target that it does not have, and the type of
  // each target column whose type it does not have. A widening casts the
  // kept values, so each position still reads. Any other change of type
  // acts as a rewrite in the commit of the change: each position before it
  // expires, and the rows that only those positions read go before the cast,
  // so no kept value blocks it. Only a change takes a lock, so a commit that
  // changes no shape waits for no reader. Gives the target's columns, and
  // whether the change expired the positions before it.
  async #follow(
    sql: Queries,
    target: string,
    change: () => Promise<number>,
  ): Promise<{ columns: string[]; rewritten: boolean }> {
    const columns = await storedColumns(sql, target);
    const kept = new Map(
      (await storedColumns(sql, this.qualifiedName)).map(({ name, type }) => [
        name,
        type,
      ]),
    );
    const rewritten = columns.some(({ name, type }) => {
      const had = kept.get(name);
      return had !== undefined && had !== type && !widens(had, type);
    });
    if (rewritten) {
      const changedIn = await change();
      await expireBefore(sql, changedIn);
      await sql.unsafe(
        `DELETE FROM ${this.qualifiedName} WHERE "replaced_in" <= $1`,
        [changedIn],
      );
    }
    for (const { name, type } of columns) {
      const column = quote(name);
      const had = kept.get(name);
      if (had === undefined)
        await sql.unsafe(
          `ALTER TABLE ${this.qualifiedName} ADD COLUMN ${column} ${type}`,
        );
      else if (had !== type)
        await sql.unsafe(
          `ALTER TABLE ${this.qualifiedName} ALTER COLUMN ${column} TYPE ${type} USING ${column}::${type}`,
        );
    }
    return { columns: columns.map(({ name }) => name), rewritten };
  }

  // Deletes the rows that only a reading before min_valid reads, which the
  // retention or a change of type left, once the history exists.
  async expire(sql: Queries): Promise<void> {
    const [history] = await sql.unsafe(
      'SELECT to_regclass($1) IS NOT NULL AS "exists"',
      [this.qualifiedName],
    );
    if (history?.exists !== true) return;
    await sql.unsafe(
      `DELETE FROM ${this.qualifiedName} WHERE "replaced_in" <= $1`,
      [await minValid(sql)],
    );
  }

  // Copies the rows of the target that rows selects into the history, as
  // replaced in commit replacedIn. rows is the FROM clause of a SELECT in
  // which "_elt_old" names the target. A commit that expired the positions
  // before it keeps no row, as only those positions would read it.
  async keep(
    sql: Queries,
    replacedIn: number,
    target: string,
    rows: string,
    params: readonly string[] = [],
  ): Promise<void> {
    const { columns, rewritten } = await this.#follow(
      sql,
      target,
      async () => replacedIn,
    );
    if (rewritten) return;
    const quoted = columns.map(quote);
    await sql.unsafe(
      `INSERT INTO ${this.qualifiedName} (${quoted.join(', ')}, "replaced_in") SELECT ${quoted.map((column) => `"_elt_old".${column}`).join(', ')}, ${Math.trunc(replacedIn)} ${rows}`,
      [...params],
    );
  }
}

// Whether a change of a column from type from to type to maps each old value
// to one value of the new type exactly, with no loss: a widening. Table
// formats that change a column's type in place allow only these, and read
// the past with its own schema, which one Postgres view cannot: Delta Lake's
// type widening (byte to short to int to long, float to double, decimal
// precision up, date to timestamp_ntz), Iceberg's promotions (int to long,
// float to double, decimal precision up), BigQuery's change to a less
// restrictive type, and Snowflake's longer VARCHAR and larger NUMBER. Every
// value has an exact text form, so each type widens to text, and an array
// widens when its item does. bigint does not widen to double precision: past
// 2^53 it loses digits, and Databricks refuses long to double too.
function widens(from: string, to: string): boolean {
  if (to === 'text') return true;
  if (from.endsWith('[]') && to.endsWith('[]'))
    return widens(from.slice(0, -2), to.slice(0, -2));
  return widenings.get(from) === to;
}

// The widenings between the types the destination declares, as Postgres
// spells them, other than to text.
const widenings: ReadonlyMap<string, string> = new Map([
  ['bigint', 'numeric'],
  ['date', 'timestamp without time zone'],
]);

// The SHA-256 of the values of a staged row, which names its version: a
// commit that finds the stored row with the same hash leaves it as it is.
// Each value that is not null counts with its column's name, so a column the
// stream adds, null in each stored row, makes no new version. A stored file
// counts as the SHA-256 of its bytes, not as its id.
export function rowHash(
  columns: readonly { readonly name: string }[],
  values: readonly (EncodedValue | Uint8Array)[],
): string {
  const digest = createHash('sha256');
  const add = (tag: string, data: string | Uint8Array) => {
    digest.update(`${tag}${Buffer.byteLength(data)}:`);
    digest.update(data);
  };
  columns.forEach((column, index) => {
    const value = values[index];
    if (value === null || value === undefined) return;
    add('c', column.name);
    if (value instanceof Uint8Array) add('b', value);
    else if (typeof value === 'string') add('t', value);
    else add('j', JSON.stringify(value));
  });
  return digest.digest('hex');
}
