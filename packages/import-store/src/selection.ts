import type { ImportScope } from '@workspace/source-apple-macos/import-scope';

// One connector's import: what it covers, and whether it copies attachment
// files.
export type Selection = {
  readonly connector: string;
  readonly scope: ImportScope;
  readonly includeAttachments: boolean;
};

// What a connector's source can be narrowed by.
export type ConnectorFacts = {
  narrowsBy(kind: 'accountIds' | 'collectionIds'): boolean;
  // What a date range selects, or null when the app's records have no date.
  readonly datedBy: string | null;
};

const named = { accountIds: 'account', collectionIds: 'collection' } as const;

// Why a selection cannot be imported, one problem per line; empty when it can.
export function selectionProblems(
  selections: readonly Selection[],
  facts: (connector: string) => ConnectorFacts,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { connector, scope } of selections) {
    if (seen.has(connector))
      problems.push(`${connector}: choose each connector once`);
    seen.add(connector);
    const traits = facts(connector);
    for (const kind of ['accountIds', 'collectionIds'] as const) {
      const ids = scope[kind];
      if (ids === undefined) continue;
      if (!traits.narrowsBy(kind))
        problems.push(`${connector}: cannot be narrowed by ${named[kind]} IDs`);
      if (ids.length === 0)
        problems.push(`${connector}: choose at least one ${named[kind]}`);
      if (new Set(ids).size !== ids.length)
        problems.push(`${connector}: choose each ${named[kind]} once`);
    }
    if (
      traits.datedBy === null &&
      (scope.startAt !== undefined || scope.endAt !== undefined)
    )
      problems.push(`${connector}: date filtering is unavailable`);
    if (
      scope.startAt !== undefined &&
      scope.endAt !== undefined &&
      scope.startAt >= scope.endAt
    )
      problems.push(`${connector}: start must precede end`);
  }
  return problems;
}
