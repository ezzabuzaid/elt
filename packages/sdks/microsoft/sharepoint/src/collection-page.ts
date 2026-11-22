/**
 * One page of a collection of Graph, such as the children of a folder. A
 * page with a `nextLink` has more pages after it; the last page has none.
 */
export type CollectionPage<T> =
  | { readonly items: readonly T[]; readonly nextLink: string }
  | { readonly items: readonly T[] };
