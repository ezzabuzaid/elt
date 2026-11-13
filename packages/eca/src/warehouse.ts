/**
 * The warehouse as of one position: `sql` reads it as it was there, and
 * `at` is the time that the reading stands for.
 */
export type Reading<Sql> = {
  readonly sql: Sql;
  readonly position: string;
  readonly at: Temporal.Instant;
};

/**
 * What eca needs of the warehouse that its rules read, such as elt's SQLite
 * or Postgres destination. The host gives it, so eca never learns where the
 * data lives. A position names a commit where no pass is half done; one that
 * the warehouse can no longer read gives `{ expired }`.
 */
export interface Warehouse<Sql> {
  // The positions after one, ascending.
  stable(
    after: string,
  ): Promise<readonly string[] | { readonly expired: string }>;
  // The warehouse as of a position, or as of its newest one. eca disposes it.
  read(
    position?: string,
  ): Promise<
    | (Reading<Sql> & (AsyncDisposable | Disposable))
    | { readonly expired: string }
  >;
}
