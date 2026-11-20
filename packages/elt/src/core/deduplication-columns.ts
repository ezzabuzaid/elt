import type { CopyConfiguration } from './copy-configuration.ts';
import type { Deduplication } from './deduplication.ts';

// The columns of a target that a deduplicating load matches and orders its
// records by.
export type DeduplicationColumns<Column> = {
  readonly deduplication: Deduplication;
  // In the order of the copy's primary key.
  readonly keys: readonly Column[];
  readonly cursor?: Column;
  // The cursor that rejects out-of-order replay: cursor_newer's. replace lets
  // the newest extraction win, so it has none.
  readonly guard?: Column;
};

// The key and cursor columns of a deduplicating copy. Each is the target's
// column of its field, and keeps the type that the destination infers from
// the stream, as typeOf spells it, so the stored values compare as the
// source's do.
export function deduplicationColumns<Column extends { readonly field: string }>(
  configuration: CopyConfiguration,
  columns: readonly Column[],
  inferred: readonly Column[],
  typeOf: (column: Column) => string,
): DeduplicationColumns<Column> {
  const deduplication = configuration.deduplication();
  const column = (field: string): Column => {
    const selected = columns.find((column) => column.field === field);
    if (selected === undefined)
      throw new TypeError(`Deduplication requires destination column ${field}`);
    const source = inferred.find((column) => column.field === field);
    if (source === undefined || typeOf(selected) !== typeOf(source))
      throw new TypeError(
        `Deduplication column ${field} must preserve the source scalar type`,
      );
    return selected;
  };
  const keys = Object.freeze(deduplication.primaryKey.map(column));
  const { cursorField } = deduplication;
  const cursor = cursorField === undefined ? undefined : column(cursorField);
  return Object.freeze({
    deduplication,
    keys,
    cursor,
    guard: configuration.dedupPolicy === 'replace' ? undefined : cursor,
  });
}
