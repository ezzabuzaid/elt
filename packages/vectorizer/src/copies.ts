import type { Connection, Copy, Destination, Target } from '@eltjs/elt';

// The copies of the pipeline that load into the destination that holds a
// vectorizer's relations, which holds tells by the engine's own test: the
// same SQLite file, or the same Postgres database.
export function copiesInto<Into extends Target>(
  connections: readonly Connection<Into>[],
  holds: (destination: Destination<Into>) => boolean,
): readonly Copy<Into>[] {
  return connections
    .filter(({ destination }) => holds(destination))
    .flatMap(({ steps }) => steps);
}
