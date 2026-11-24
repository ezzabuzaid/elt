import { hash } from 'node:crypto';

import type { DatasetIndex, VectorMetric } from '@eltjs/elt';

import { quote } from './identifier.ts';
import type { Transaction } from './postgres-load.ts';
import { warehouse } from './postgres-schemas.ts';

// The build of an HNSW index of pgvector: m, the most links of each node of
// the graph, and efConstruction, the size of the list of candidates while
// the graph is built. pgvector takes its own defaults for the ones not given
// (16 and 64 in pgvector 0.8).
export type Hnsw = {
  readonly method: 'hnsw';
  readonly m?: number;
  readonly efConstruction?: number;
};

// The build of an HNSW index, as pgai's ai.indexing_hnsw() declares one.
export function hnsw(options: Omit<Hnsw, 'method'> = {}): Hnsw {
  return Object.freeze({ method: 'hnsw', ...options });
}

// An index that a computed dataset declares on one of its tables, in the
// declaration of elt: an ordinary btree index over key columns, or a vector
// index over one vector column with the metric of its search and its build.
export type PostgresIndex = DatasetIndex<'btree', { readonly build: Hnsw }>;

// The operator class of pgvector for each metric: the search orders by <=>
// for cosine, <-> for euclidean and <#> for dot.
const operatorClasses: Readonly<Record<VectorMetric, string>> = {
  cosine: 'vector_cosine_ops',
  euclidean: 'vector_l2_ops',
  dot: 'vector_ip_ops',
};

// The start of the name of each index that the destination manages. A
// person's own index has another name, so the destination never drops it.
const managed = 'ix_elt_';

// The declared indexes of one table of a computed dataset, each under a name
// that the destination derives from the statement that makes it. The
// statement holds the table: an index name is unique in its schema in
// Postgres, and a changed declaration is another index. reconcile brings the
// table to them in place, with no make of the table again and no recompute.
export class TableIndexes {
  readonly #table: string;
  // The statement that makes each declared index, by its name.
  readonly #declared: ReadonlyMap<string, string>;

  // Refuses an index that the table cannot have, before anything is made: a
  // column that the table does not have, and a vector index on a column that
  // is not a vector.
  constructor({
    dataset,
    table,
    columns,
    indexes,
  }: {
    dataset: string;
    table: string;
    columns: readonly { readonly name: string; readonly type: string }[];
    indexes: readonly PostgresIndex[];
  }) {
    const column = (name: string) => {
      const found = columns.find((declared) => declared.name === name);
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
          const { m, efConstruction } = index.build;
          const options = [
            ...(m === undefined ? [] : [`m = ${m}`]),
            ...(efConstruction === undefined
              ? []
              : [`ef_construction = ${efConstruction}`]),
          ];
          return named(
            `ON ${table} USING hnsw (${quote(name)} ${operatorClasses[index.metric]})${options.length === 0 ? '' : ` WITH (${options.join(', ')})`}`,
          );
        }
        const keys = index.columns.map((key) => quote(column(key).name));
        return named(`ON ${table} USING btree (${keys.join(', ')})`);
      }),
    );
    Object.freeze(this);
  }

  // Drops each managed index of the table that is no longer declared, then
  // makes each declared index that the table does not have, in the
  // transaction of sql.
  async reconcile(sql: Transaction): Promise<void> {
    const stored = new Set(
      (
        await sql.unsafe<{ name: string }[]>(
          `SELECT c.relname AS "name" FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = to_regclass($1) AND starts_with(c.relname, $2)`,
          [this.#table, managed],
        )
      ).map(({ name }) => name),
    );
    for (const name of stored)
      if (!this.#declared.has(name))
        await sql.unsafe(`DROP INDEX ${quote(warehouse)}.${quote(name)}`);
    for (const [name, statement] of this.#declared)
      if (!stored.has(name)) await sql.unsafe(statement);
  }
}

// The name of an index and the statement that makes it, from the part of
// the statement after the name: the managed prefix and the first 16 hex
// digits of the SHA-256 of that part, which holds the table and each
// option, so each change of the declaration is another name.
function named(definition: string): [string, string] {
  const name = `${managed}${hash('sha256', definition).slice(0, 16)}`;
  return [name, `CREATE INDEX ${quote(name)} ${definition}`];
}
