// What an import of one app covers: native account and collection IDs (Notes
// folders, Mail mailboxes, Messages chats, Contacts containers, Calendar
// calendars, Reminders lists) and a date range, startAt inclusive and endAt
// exclusive. An absent key means all.
export type ImportScope = {
  readonly accountIds?: readonly string[];
  readonly collectionIds?: readonly string[];
  readonly startAt?: string;
  readonly endAt?: string;
};

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
