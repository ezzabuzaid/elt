import { hash } from 'node:crypto';

import type { DatasetIndex } from '@eltjs/elt';
import type { SqlServerConnection } from '@eltjs/sdk-microsoft-sql-server';

import { TargetDescriptions } from './sql-server-descriptions.ts';
import { identifiers, quote } from './sql-server-identifiers.ts';
import type { Declared } from './sql-server-rule-columns.ts';
import { inMarts, marts } from './sql-server-schemas.ts';

// An index that a computed dataset declares on one of its tables, in the
// declaration of elt: an ordinary nonclustered index over key columns, or a
// DiskANN vector index over one vector column with the metric of its search.
// SQL Server takes no options for the build of a DiskANN index.
export type SqlServerIndex = DatasetIndex<'nonclustered', Record<never, never>>;

// The start of the name of each index that the destination manages. A
// person's own index has another name, so the destination never drops it.
const managed = 'ix_elt_';

// The declared indexes of one table of a computed dataset, each under a name
// that the destination derives from its declaration, so a changed
// declaration is another index. reconcile brings the table to them in place,
// with no make of the table again and no recompute.
// A vector index has its search, the inline table-valued function
// marts.<reader>_nearest(@query, @k), named after the reader view of the
// table: VECTOR_SEARCH uses the index only on a base table, and readers read
// only marts. It gives the keys and the distance of the k nearest rows of the
// table as it is now. It and the table have one owner, so a reader that may
// read the function needs nothing of _warehouse (ADR 0014).
export class TableIndexes {
  // The relations of marts that the table's search takes, schema-qualified:
  // none when the table has no vector index.
  readonly names: readonly string[];
  readonly #table: string;
  // The statement that makes each declared index, by its name.
  readonly #declared: ReadonlyMap<string, string>;
  // The function that searches the vector index, in marts, by its name.
  readonly #name: string;
  readonly #search: string;
  // The definition of the search, from FUNCTION on, as SQL Server keeps it,
  // and its descriptions, which the catalog lists; undefined when the table
  // has no vector index.
  readonly #nearest:
    | { readonly definition: string; readonly descriptions: TargetDescriptions }
    | undefined;

  // Refuses an index that the table cannot have, before anything is made: a
  // column that the table does not have, a vector index on a column that is
  // not a vector, an index key that SQL Server refuses (error 1919 for a
  // (max) type, 1978 for a vector), and a search that cannot have its name
  // or its columns: a second vector index, and a key named distance. keys
  // are the columns that name a row of the table, which the search gives.
  constructor({
    dataset,
    table,
    reader,
    keys,
    columns,
    indexes,
  }: {
    dataset: string;
    table: string;
    reader: string;
    keys: readonly string[];
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
    const name = identifiers.relation(`${reader}_nearest`);
    this.#name = name;
    this.#search = inMarts(name);
    const vectors = indexes.filter((index) => index.type === 'vector');
    const [vector] = vectors;
    if (vectors.length > 1)
      throw new TypeError(
        `Computed dataset ${dataset} declares ${vectors.length} vector indexes on ${table}, and ${this.#search} searches one`,
      );
    const distance = keys.find((key) => identifiers.key(key) === 'distance');
    if (vector !== undefined && distance !== undefined)
      throw new TypeError(
        `Computed dataset ${dataset} cannot search ${table} through ${this.#search}: its column ${distance} has the name of the distance that the search gives`,
      );
    this.names = Object.freeze(
      vector === undefined ? [] : [`${marts}.${name}`],
    );
    if (vector === undefined) this.#nearest = undefined;
    else {
      const searched = column(vector.column);
      this.#nearest = {
        definition: `FUNCTION ${this.#search}(@query ${searched.type}, @k int) RETURNS TABLE AS RETURN SELECT TOP (@k) WITH APPROXIMATE ${keys.map((key) => `t.${quote(key)}`).join(', ')}, r.[distance] FROM VECTOR_SEARCH(TABLE = ${table} AS t, COLUMN = ${quote(searched.name)}, SIMILAR_TO = @query, METRIC = '${vector.metric}') AS r ORDER BY r.[distance]`,
        descriptions: new TargetDescriptions(
          `The approximate nearest rows of ${marts}.${reader} to @query, a ${searched.type}, by the ${vector.metric} distance of ${searched.name}, through its vector index: the @k nearest rows of the table as it is now, nearest first. A search as of a position reads ${marts}.${reader} with VECTOR_DISTANCE.`,
          {
            ...Object.fromEntries(
              keys.map((key) => [
                key,
                `The ${key} of the row in ${marts}.${reader}.`,
              ]),
            ),
            distance: `The ${vector.metric} distance of ${searched.name} from @query; a smaller distance is nearer.`,
          },
        ),
      };
    }
    Object.freeze(this);
  }

  // Drops each managed index of the table that is no longer declared, then
  // makes each declared index that the table does not have, then makes the
  // search of the vector index, or makes it again when its stored
  // definition differs, and writes its descriptions, or drops it when the
  // table has no vector index. Each statement runs outside a transaction,
  // since SQL Server makes a vector index only there (error 574); a refresh
  // that stops between two of them makes the rest the next time.
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
    const search = await searchDefinition(connection, this.#search);
    if (this.#nearest === undefined) {
      if (search !== undefined)
        await connection.query(`DROP FUNCTION ${this.#search}`);
    } else {
      if (search !== this.#nearest.definition)
        await connection.query(`CREATE OR ALTER ${this.#nearest.definition}`);
      await this.#nearest.descriptions.write(
        connection,
        'FUNCTION',
        marts,
        this.#name,
      );
    }
  }
}

// The definition of the inline table-valued function name, from FUNCTION on,
// or undefined when the database has none of that name. SQL Server keeps the
// text of the statement that made the function, with CREATE OR ALTER kept
// as CREATE   (Azure probe of ADR 0014), so the words before FUNCTION are
// skipped.
async function searchDefinition(
  connection: SqlServerConnection,
  name: string,
): Promise<string | undefined> {
  const [stored] = await connection.query(
    "SELECT OBJECT_DEFINITION(OBJECT_ID(@name, N'IF')) AS [definition]",
    { name },
  );
  return typeof stored?.definition === 'string'
    ? stored.definition.replace(/^CREATE\s+(?:OR\s+ALTER\s+)?/i, '')
    : undefined;
}

// The name of an index: the managed prefix and the first 16 hex digits of the
// SHA-256 of its declaration.
const derivedName = (declaration: readonly string[]) =>
  `${managed}${hash('sha256', JSON.stringify(declaration)).slice(0, 16)}`;
