import { isDeepStrictEqual } from 'node:util';
import type { DestinationSyncMode } from './destination.ts';

// One writer's standing claim on a destination target, stored with the target.
export type WriterClaim = {
  readonly writer: string;
  readonly destinationSyncMode: DestinationSyncMode;
  readonly primaryKey: readonly string[] | null;
};

// Writers may share a target only when each upserts and deletes by the same
// key, so none can remove or shadow rows another wrote. An overwrite empties
// the whole target and an append log cannot tell its rows apart, so both
// need the target to themselves. A writer may always change its own claim.
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
      isDeepStrictEqual(other.primaryKey, claim.primaryKey)
    )
      continue;
    throw new TypeError(
      `Target ${target} is written by ${describe(other)}; ${describe(claim)} cannot share it. Writers share a target only when all use append_dedup on the same primaryKey. Drop the target to reassign it.`,
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

function describe({
  writer,
  destinationSyncMode,
  primaryKey,
}: WriterClaim): string {
  return `${writer} (${destinationSyncMode}${primaryKey === null ? '' : ` on ${JSON.stringify(primaryKey)}`})`;
}

function isClaim(value: unknown): value is WriterClaim {
  if (value === null || typeof value !== 'object') return false;
  const writer: unknown = Reflect.get(value, 'writer');
  const destinationSyncMode: unknown = Reflect.get(
    value,
    'destinationSyncMode',
  );
  const primaryKey: unknown = Reflect.get(value, 'primaryKey');
  return (
    typeof writer === 'string' &&
    writer.length > 0 &&
    ['append', 'overwrite', 'append_dedup', 'overwrite_dedup'].includes(
      String(destinationSyncMode),
    ) &&
    (primaryKey === null ||
      (Array.isArray(primaryKey) &&
        primaryKey.every((field) => typeof field === 'string')))
  );
}
