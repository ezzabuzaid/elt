import { AppleConnector } from '@workspace/connector-apple-connector/apple-connector';
import {
  type Choice,
  byId,
  name,
} from '@workspace/connector-apple-connector/choice';
import type { ImportScope } from '@workspace/source-apple-macos/import-scope';
import { SlackDesktopSource } from '@workspace/source-slack-desktop/slack-desktop-source';

// A conversation's workspace, then the conversation as Slack's sidebar names
// it; a direct message is named by the other person's member ID.
const conversation: Choice['label'] = (row, rows) => {
  const workspace = rows
    .get('workspaces')
    ?.find(({ id }) => id === row.workspaceId);
  const label = conversationLabel(row);
  return workspace === undefined ? label : `${name(workspace)} / ${label}`;
};

function conversationLabel(row: Parameters<typeof name>[0]): string {
  if (row.kind === 'im') return `direct message ${String(row.imUserId)}`;
  if (row.kind === 'mpim') return name(row);
  return `#${name(row)}`;
}

export default class SlackConnector extends AppleConnector {
  readonly datedBy = 'date sent';
  readonly fullDiskAccess = true;
  override readonly note =
    'Slack keeps only the messages it has loaded on this Mac, so older history is imported only once Slack loads it.';
  protected readonly choices: readonly Choice[] = [
    {
      stream: 'workspaces',
      scope: 'accountIds',
      title: 'workspaces',
      id: byId,
      label: name,
    },
    {
      stream: 'channels',
      scope: 'collectionIds',
      title: 'conversations',
      id: byId,
      label: conversation,
    },
  ];
  protected readonly unscoped = [];
  protected readonly storeCopies = [];

  protected access(): string {
    return 'Open Slack in each workspace to import and let it run: it saves what it has loaded every few minutes and when it quits, and only messages it has loaded on this Mac are imported.';
  }

  protected source(scope: ImportScope) {
    return new SlackDesktopSource(undefined, scope);
  }
}
