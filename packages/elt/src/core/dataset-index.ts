// The distance by which the search of a vector index orders the rows,
// nearest first: the cosine distance, the Euclidean (L2) distance, or the
// negative dot product, as SQL Server's VECTOR_DISTANCE and pgvector's
// operator classes name them.
export type VectorMetric = 'cosine' | 'euclidean' | 'dot';

// An index that a computed dataset declares on one of its tables, which its
// destination makes at each refresh and drops when the declaration no longer
// has it (elt-sqlserver ADR 0013), as dbt's indexes config and pgai's
// indexing declare: an ordinary index over key columns, of the kind that
// Ordinary names in the engine of the destination, such as nonclustered in
// SQL Server; or an index for the approximate search of one vector column by
// its metric, with the options of its build that Build gives in that engine,
// such as the m of HNSW in Postgres.
export type DatasetIndex<Ordinary extends string, Build extends object> =
  | {
      readonly type: Ordinary;
      readonly columns: readonly [string, ...string[]];
    }
  | ({
      readonly type: 'vector';
      readonly column: string;
      readonly metric: VectorMetric;
    } & Build);
