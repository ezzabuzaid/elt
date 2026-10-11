// What eca needs of the warehouse its rules read. The host gives one, so eca
// never learns where the data lives or what holds it.
export interface Warehouse<Sql> {
  // The read-only handle that every condition queries.
  readonly sql: Sql;
  // One item each time new data is committed to the warehouse, until signal
  // aborts.
  commits(signal: AbortSignal): AsyncIterable<unknown>;
}
