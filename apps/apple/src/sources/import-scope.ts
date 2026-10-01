import type { ImportScope } from 'import-store';

export type { ImportScope };

export function selected(
  ids: readonly string[] | undefined,
  id: unknown,
): boolean {
  return ids === undefined || (typeof id === 'string' && ids.includes(id));
}

// Missing dates cannot establish that a record lies inside a requested interval.
export function withinDates(scope: ImportScope, value: unknown): boolean {
  if (scope.startAt === undefined && scope.endAt === undefined) return true;
  return (
    typeof value === 'string' &&
    (scope.startAt === undefined || value >= scope.startAt) &&
    (scope.endAt === undefined || value < scope.endAt)
  );
}
