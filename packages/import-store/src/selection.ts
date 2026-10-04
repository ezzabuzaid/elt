import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

// One app's import: what it covers, and whether it copies attachment files.
export type Selection = {
  readonly app: string;
  readonly scope: ImportScope;
  readonly includeAttachments: boolean;
};

// What an app's source can be narrowed by.
export type AppFacts = {
  narrowsBy(kind: 'accountIds' | 'collectionIds'): boolean;
  // What a date range selects, or null when the app's records have no date.
  readonly datedBy: string | null;
};

const named = { accountIds: 'account', collectionIds: 'collection' } as const;

// Why a selection cannot be imported, one problem per line; empty when it can.
export function selectionProblems(
  selections: readonly Selection[],
  facts: (app: string) => AppFacts,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { app, scope } of selections) {
    if (seen.has(app)) problems.push(`${app}: choose each app once`);
    seen.add(app);
    const traits = facts(app);
    for (const kind of ['accountIds', 'collectionIds'] as const) {
      const ids = scope[kind];
      if (ids === undefined) continue;
      if (!traits.narrowsBy(kind))
        problems.push(`${app}: cannot be narrowed by ${named[kind]} IDs`);
      if (ids.length === 0)
        problems.push(`${app}: choose at least one ${named[kind]}`);
      if (new Set(ids).size !== ids.length)
        problems.push(`${app}: choose each ${named[kind]} once`);
    }
    if (
      traits.datedBy === null &&
      (scope.startAt !== undefined || scope.endAt !== undefined)
    )
      problems.push(`${app}: date filtering is unavailable`);
    if (
      scope.startAt !== undefined &&
      scope.endAt !== undefined &&
      scope.startAt >= scope.endAt
    )
      problems.push(`${app}: start must precede end`);
  }
  return problems;
}
