import { hash } from 'node:crypto';

import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { identifiers, quote } from './sql-server-identifiers.ts';
import type { Declared } from './sql-server-rule-columns.ts';

// An index that a computed dataset declares on one of its tables: an
// ordinary nonclustered index over key columns, or a DiskANN vector index
// over one vector column with the metric of its search, as SQL Server names
// it.
export type SqlServerIndex =
  | {
      readonly type: 'nonclustered';
      readonly columns: readonly [string, ...string[]];
    }
  | {
      readonly type: 'vector';
      readonly column: string;
      readonly metric: 'cosine' | 'euclidean' | 'dot';
    };

// The start of the name of each index that the destination manages. A
// person's own index has another name, so the destination never drops it.
const managed = 'ix_elt_';

// The declared indexes of one table of a computed dataset, each under a name
// that the destination derives from its declaration, so a changed
// declaration is another index. reconcile brings the table to them in place,
// with no make of the table again and no recompute.
export class TableIndexes {
  readonly #table: string;
  // The statement that makes each declared index, by its name.
  readonly #declared: ReadonlyMap<string, string>;

  // Refuses an index that the table cannot have, before anything is made: a
  // column that the table does not have, a vector index on a column that is
  // not a vector, and an index key that SQL Server refuses (error 1919 for
  // a (max) type, 1978 for a vector).
  constructor({
    dataset,
    table,
    columns,
    indexes,
  }: {
    dataset: string;
    table: string;
    columns: readonly Declared[];
    indexes: readonly SqlServerIndex[];
  }) {
    const column = (name: string): Declared => {
      const found = columns.find(
        (declared) => identifiers.key(declared.name) === identifiers.key(name),
      );
      if (found === undefined)
        throw new TypeError(
          `Computed dataset ${dataset} declares an index on ${name}, which ${table} does not have`,
        );
      return found;
    };
    this.#table = table;
    this.#declared = new Map(
      indexes.map((index) => {
        if (index.type === 'vector') {
          const { name, type } = column(index.column);
          if (!type.startsWith('vector('))
            throw new TypeError(
              `Computed dataset ${dataset} declares a vector index on ${name}, which is ${type}, not a vector`,
            );
          const indexName = derivedName(['vector', name, index.metric]);
          return [
            indexName,
            `CREATE VECTOR INDEX ${quote(indexName)} ON ${table} (${quote(name)}) WITH (METRIC = '${index.metric}', TYPE = 'DiskANN')`,
          ];
        }
        const keys = index.columns.map((key) => {
          const { name, type } = column(key);
          if (type.endsWith('(max)') || type.startsWith('vector('))
            throw new TypeError(
              `Computed dataset ${dataset} cannot make ${name} an index key: SQL Server refuses a column of type ${type} as one`,
            );
          return name;
        });
        const indexName = derivedName(['nonclustered', ...keys]);
        return [
          indexName,
          `CREATE NONCLUSTERED INDEX ${quote(indexName)} ON ${table} (${keys.map(quote).join(', ')})`,
        ];
      }),
    );
    Object.freeze(this);
  }

  // Drops each managed index of the table that is no longer declared, then
  // makes each declared index that the table does not have. Each statement
  // runs outside a transaction, since SQL Server makes a vector index only
  // there (error 574); a refresh that stops between two of them makes the
  // rest the next time.
  async reconcile(connection: SqlServerConnection): Promise<void> {
    const stored = new Set(
      (
        await connection.query(
          `SELECT [name] FROM sys.indexes WHERE [object_id] = OBJECT_ID(@table) AND [name] LIKE N'${managed.replaceAll('_', '[_]')}%'`,
          { table: this.#table },
        )
      ).map(({ name }) => String(name)),
    );
    for (const name of stored)
      if (!this.#declared.has(name))
        await connection.query(`DROP INDEX ${quote(name)} ON ${this.#table}`);
    for (const [name, statement] of this.#declared)
      if (!stored.has(name)) await connection.query(statement);
  }
}

// The name of an index: the managed prefix and the first 16 hex digits of the
// SHA-256 of its declaration.
const derivedName = (declaration: readonly string[]) =>
  `${managed}${hash('sha256', JSON.stringify(declaration)).slice(0, 16)}`;
