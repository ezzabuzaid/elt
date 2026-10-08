import type { DestinationSyncMode } from './destination.ts';

// How a stored table compares with the one a stream needs.
export type StoredFit = 'missing' | 'stale' | 'fits';

// What a load does with its target: load into it as it is, create it, evolve
// a stored target to the stream's shape keeping its rows, open a reload into a
// new hidden target, or continue the reload the copy's last run left open.
// Any other hidden target is a leftover, which the load drops. A RESET of the
// whole stream opens a reload, and so does an overwrite whose stored target
// no longer fits.
export type ReloadMode = 'load' | 'create' | 'evolve' | 'reload' | 'continue';

// Every destination decides alike: an open reload continues into a hidden
// target that still fits, or starts over in a new one, and a stored target
// that no longer fits the stream evolves to it. An overwrite keeps none of
// the stored rows, so it reloads that target instead, as Airbyte's truncate
// syncs load a new table and swap it in.
export function reloadMode({
  reloading,
  destinationSyncMode,
  target,
  hidden,
}: {
  readonly reloading: boolean;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly target: StoredFit;
  readonly hidden: StoredFit;
}): ReloadMode {
  if (reloading) return hidden === 'fits' ? 'continue' : 'reload';
  if (target === 'missing') return 'create';
  if (target === 'stale') {
    const overwrites =
      destinationSyncMode === 'overwrite' ||
      destinationSyncMode === 'overwrite_dedup';
    return overwrites ? 'reload' : 'evolve';
  }
  return 'load';
}
