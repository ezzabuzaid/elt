import type { TeamsClient, TeamsMessage } from '@workspace/sdk-microsoft-teams';
import {
  type ImportScope,
  selected,
  withinDates,
} from '@workspace/source-apple-macos/import-scope';

// One run's read of the Teams app's store: every stream reads what the web
// client had saved when the run opened. The import scope keeps the selected
// accounts, the selected conversations (collections) and the messages sent
// within its dates; people, meetings, call logs, activity and apps belong to
// an account, not a conversation, so a conversation selection keeps them.
export class TeamsScan implements AsyncDisposable {
  readonly #clients: readonly TeamsClient[];
  readonly #scope: ImportScope;
  readonly #kept: ReadonlyMap<string, TeamsClient>;

  constructor(clients: readonly TeamsClient[], scope: ImportScope) {
    this.#clients = clients;
    this.#scope = scope;
    this.#kept = new Map(
      clients.map((client) => [client.account.userId, client]),
    );
  }

  get clients(): readonly TeamsClient[] {
    return this.#clients.filter(({ account }) =>
      selected(this.#scope.accountIds, account.userId),
    );
  }

  // Whether the app still keeps this account: one it no longer keeps, such
  // as one signed out of, says nothing about its rows, so they stay.
  keeps(accountId: unknown): boolean {
    return typeof accountId === 'string' && this.#kept.has(accountId);
  }

  // Whether the app holds this part of a conversation's history, so a
  // message it no longer lists there was deleted rather than dropped from its
  // cache.
  holds(
    accountId: unknown,
    conversationId: unknown,
    threadId: unknown,
    messageId: unknown,
  ): boolean {
    return (
      typeof accountId === 'string' &&
      typeof conversationId === 'string' &&
      typeof threadId === 'string' &&
      typeof messageId === 'string' &&
      (this.#kept.get(accountId)?.holds(conversationId, threadId, messageId) ??
        false)
    );
  }

  // Whether the app keeps this conversation's member list, so a member it no
  // longer lists there left.
  holdsMembers(accountId: unknown, conversationId: unknown): boolean {
    return (
      typeof accountId === 'string' &&
      (this.#kept
        .get(accountId)
        ?.conversations.some(
          ({ id, members }) => id === conversationId && members !== null,
        ) ??
        false)
    );
  }

  // Whether the app still holds this meeting, so an attendee it no longer
  // lists there was removed.
  holdsMeeting(accountId: unknown, meetingId: unknown): boolean {
    return (
      typeof accountId === 'string' &&
      (this.#kept.get(accountId)?.meetings.some(({ id }) => id === meetingId) ??
        false)
    );
  }

  holdsApps(accountId: unknown, scope: unknown, scopeId: unknown): boolean {
    return (
      typeof accountId === 'string' &&
      typeof scope === 'string' &&
      typeof scopeId === 'string' &&
      (this.#kept.get(accountId)?.holdsApps(scope, scopeId) ?? false)
    );
  }

  conversationSelected(conversationId: string): boolean {
    return selected(this.#scope.collectionIds, conversationId);
  }

  messages(client: TeamsClient): readonly TeamsMessage[] {
    return client.messages.filter(
      ({ conversationId, sentAt }) =>
        this.conversationSelected(conversationId) &&
        withinDates(this.#scope, sentAt),
    );
  }

  // Everything was read when the scan opened; nothing stays open.
  async [Symbol.asyncDispose](): Promise<void> {}
}
