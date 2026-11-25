import type { Copy, Target } from '@eltjs/elt';

import { type Loading, type SourceKey, keyColumns } from './options.ts';

// A table of a destination that a vectorizer reads: its reader name and the
// columns that its target declares, as each destination has them.
type SourceTable = Target & {
  readonly name: string;
  readonly columns: readonly { readonly name: string }[];
};

// Refuses, before any read, a vectorizer whose table no copy into its
// destination loads, and a key, metadata or loading column that the copy's
// stream or the table does not declare. copies are the copies into the
// destination of the vectorizer, which each engine finds by its own test
// (copiesInto), and destination names that destination in the refusal, such
// as the path of a SQLite file.
export function refuseUndeclaredColumns<Into extends SourceTable>({
  vectorizer,
  from,
  copies,
  destination,
  key,
  metadata,
  loading,
}: {
  readonly vectorizer: string;
  readonly from: Into;
  readonly copies: readonly Copy<Into>[];
  readonly destination: string;
  readonly key: SourceKey;
  readonly metadata: readonly string[];
  readonly loading: Loading;
}): void {
  const copy = copies.find(({ to }) => to === from);
  if (copy === undefined)
    throw new TypeError(
      `Vectorizer ${vectorizer} reads ${from.name}, which no copy of the pipeline loads into ${destination}`,
    );
  const declared = new Set([
    ...Object.keys(copy.from.jsonSchema.properties ?? {}),
    ...from.columns.map(({ name }) => name),
  ]);
  for (const column of [
    ...keyColumns(key),
    ...metadata,
    ...('columns' in loading ? loading.columns : [loading.file]),
  ])
    if (!declared.has(column))
      throw new TypeError(
        `Vectorizer ${vectorizer} reads the column ${column} of ${from.name}, which the stream ${copy.from.name} does not declare`,
      );
}
