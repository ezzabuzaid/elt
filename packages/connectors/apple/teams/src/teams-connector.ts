import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type Choice,
  accounts,
  byId,
} from '@workspace/connector-apple-connector/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { TeamsSource } from '@workspace/source-microsoft-teams/teams-source';

// An account by its organization's first domain.
const account: Choice['label'] = (row) => {
  const domains = Array.isArray(row.tenantDomains) ? row.tenantDomains : [];
  return String(domains[0] ?? row.tenantId);
};

// A conversation as Teams' chat list names it: a channel after its team, a
// team by its name, a chat by its topic or, without one, its members.
const conversation: Choice['label'] = (row, rows) => {
  if (row.type === 'Topic') {
    const team = rows.get('conversations')?.find(({ id }) => id === row.teamId);
    const channel = String(row.topic ?? 'channel');
    return team === undefined
      ? channel
      : `${String(team.teamName ?? team.topic ?? 'team')} / ${channel}`;
  }
  if (row.type === 'Space')
    return String(row.teamName ?? row.topic ?? `team ${byId(row)}`);
  if (row.type === 'StreamOfNotes') return 'Notes';
  return String(row.topic ?? row.title ?? `${String(row.type)} ${byId(row)}`);
};

export default class TeamsConnector extends AppleConnector {
  readonly datedBy = 'date sent';
  readonly fullDiskAccess = true;
  override readonly note =
    'Teams keeps only the messages it has loaded on this Mac, so older history is imported only once Teams loads it.';
  protected readonly choices: readonly Choice[] = [
    accounts(account),
    {
      stream: 'conversations',
      scope: 'collectionIds',
      title: 'conversations',
      id: byId,
      label: conversation,
    },
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Open Microsoft Teams, sign in and let it run: it saves what it loads as you use it, and only what it has loaded on this Mac is imported.';
  }

  protected source(scope: ImportScope) {
    return new TeamsSource(undefined, scope);
  }
}
