import type { SlackClient, SlackMessage } from '@workspace/sdk-slack-desktop';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// A sent time cut to the millisecond, the precision of an import's dates, so
// it compares with them as text.
const toMilliseconds = (instant: string) => `${instant.slice(0, 23)}Z`;

// One run's read of the Slack app's store: every stream reads the clients the
// app had saved when the run opened. The import scope keeps the selected
// workspaces (accounts), the selected channels (collections) and the messages
// sent within its dates; members, apps and the like belong to a workspace, not
// a channel, so a channel selection keeps them.
export class SlackDesktopScan implements AsyncDisposable {
  readonly clients: readonly SlackClient[];
  readonly #scope: ImportScope;
  readonly #kept: ReadonlyMap<string, SlackClient>;

  constructor(clients: readonly SlackClient[], scope: ImportScope) {
    this.#scope = scope;
    this.#kept = new Map(
      clients.map((client) => [client.workspace.id, client]),
    );
    this.clients = clients.filter(({ workspace }) =>
      selected(scope.accountIds, workspace.id),
    );
  }

  // Whether the app still keeps this workspace: one it no longer keeps, such
  // as one signed out of, says nothing about its rows, so they stay.
  keeps(workspaceId: unknown): boolean {
    return typeof workspaceId === 'string' && this.#kept.has(workspaceId);
  }

  // Whether the app holds this part of a channel's history, so a message it
  // no longer lists there was deleted rather than dropped from its cache.
  holds(workspaceId: unknown, channelId: unknown, ts: unknown): boolean {
    if (typeof workspaceId !== 'string' || typeof channelId !== 'string')
      return false;
    return (
      typeof ts === 'string' &&
      (this.#kept.get(workspaceId)?.holds(channelId, ts) ?? false)
    );
  }

  channelSelected(channelId: string): boolean {
    return selected(this.#scope.collectionIds, channelId);
  }

  messages(client: SlackClient): readonly SlackMessage[] {
    return client.messages.filter((message) => this.#inScope(message));
  }

  threadReplies(client: SlackClient): readonly SlackMessage[] {
    return client.threadReplies.filter((message) => this.#inScope(message));
  }

  #inScope({ channelId, sentAt }: SlackMessage): boolean {
    return (
      this.channelSelected(channelId) &&
      withinDates(this.#scope, toMilliseconds(sentAt))
    );
  }

  // Everything was read when the scan opened; nothing stays open.
  async [Symbol.asyncDispose](): Promise<void> {}
}
