import { isDeepStrictEqual } from 'node:util';
import type { DestinationSyncMode } from './destination.ts';
import type { Partition } from './partition.ts';

// One writer's standing claim on a destination target, stored with the target.
export type WriterClaim = {
  readonly writer: string;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly primaryKey: readonly string[] | null;
  // The partitions the writer loads; null when its stream is not partitioned,
  // which means it may write any key.
  readonly partitions: readonly Partition[] | null;
};

// Writers may share a target only when each upserts and deletes by the same
// key within partitions no other writer loads, so none can remove or shadow
// rows another wrote: a snapshot writer deletes keys it once saw, and would
// delete a key another writer also loads. An overwrite empties the whole
// target and an append log cannot tell its rows apart, so both need the
// target to themselves. A writer may always change its own claim.
export function assertShareable(
  target: string,
  claims: readonly WriterClaim[],
  claim: WriterClaim,
): void {
  for (const other of claims) {
    if (other.writer === claim.writer) continue;
    if (
      other.destinationSyncMode === 'append_dedup' &&
      claim.destinationSyncMode === 'append_dedup' &&
      isDeepStrictEqual(other.primaryKey, claim.primaryKey) &&
      disjoint(other.partitions, claim.partitions)
    )
      continue;
    throw new TypeError(
      `Target ${target} is written by ${describe(other)}; ${describe(claim)} cannot share it. Writers share a target only when all use append_dedup on the same primaryKey over disjoint partitions. Drop the target to reassign it.`,
    );
  }
}

export function readClaims(claims: unknown): WriterClaim[] {
  if (!Array.isArray(claims) || !claims.every(isClaim))
    throw new TypeError('Invalid target writer claims');
  return claims;
}

// Other writers' claims plus this one, in a stable order.
export function withClaim(
  claims: readonly WriterClaim[],
  claim: WriterClaim,
): WriterClaim[] {
  return [
    ...claims.filter((other) => other.writer !== claim.writer),
    claim,
  ].sort((left, right) =>
    left.writer < right.writer ? -1 : left.writer > right.writer ? 1 : 0,
  );
}

function disjoint(
  left: readonly Partition[] | null,
  right: readonly Partition[] | null,
): boolean {
  if (left === null || right === null) return false;
  const loaded = new Set(left.map(canonical));
  return !right.some((partition) => loaded.has(canonical(partition)));
}

function canonical(partition: Partition): string {
  return JSON.stringify(
    Object.entries(partition).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

function describe({
  writer,
  destinationSyncMode,
  primaryKey,
  partitions,
}: WriterClaim): string {
  return `${writer} (${destinationSyncMode}${primaryKey === null ? '' : ` on ${JSON.stringify(primaryKey)}`}${partitions === null ? '' : ` for ${JSON.stringify(partitions)}`})`;
}

function isClaim(value: unknown): value is WriterClaim {
  if (value === null || typeof value !== 'object') return false;
  const writer: unknown = Reflect.get(value, 'writer');
  const destinationSyncMode: unknown = Reflect.get(
    value,
    'destinationSyncMode',
  );
  const primaryKey: unknown = Reflect.get(value, 'primaryKey');
  const partitions: unknown = Reflect.get(value, 'partitions');
  return (
    typeof writer === 'string' &&
    writer.length > 0 &&
    ['append', 'overwrite', 'append_dedup', 'overwrite_dedup'].includes(
      String(destinationSyncMode),
    ) &&
    (primaryKey === null ||
      (Array.isArray(primaryKey) &&
        primaryKey.every((field) => typeof field === 'string'))) &&
    (partitions === null ||
      (Array.isArray(partitions) &&
        partitions.every(
          (partition: unknown) =>
            partition !== null &&
            typeof partition === 'object' &&
            !Array.isArray(partition) &&
            Object.values(partition).every((part) =>
              ['string', 'number', 'boolean'].includes(typeof part),
            ),
        )))
  );
}
