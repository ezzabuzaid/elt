// How a stored table compares with the one a stream needs.
export type StoredFit = 'missing' | 'stale' | 'fits';

// What a load does with its target: load into it as it is, create it, open a
// reload into a new hidden target, or continue the reload the copy's last run
// left open. Any other hidden target is a leftover, which the load drops.
export type ReloadMode = 'load' | 'create' | 'reload' | 'continue';

// Every destination decides alike: an open reload continues only into a
// hidden target that still fits, and a restart or a stored target that no
// longer fits opens one, unless there is no target yet to hide behind.
export function reloadMode({
  reloading,
  restart,
  target,
  hidden,
}: {
  readonly reloading: boolean;
  readonly restart: boolean;
  readonly target: StoredFit;
  readonly hidden: StoredFit;
}): ReloadMode {
  if (reloading) return hidden === 'fits' ? 'continue' : 'reload';
  if (target === 'missing') return 'create';
  if (restart || target === 'stale') return 'reload';
  return 'load';
}
