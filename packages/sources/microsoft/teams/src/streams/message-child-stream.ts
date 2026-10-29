import type { KeyValue } from '@zukhruf/snapshot-differential';

import type { Properties, RecordDraft } from '@workspace/elt';
import type { TeamsMessage } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, conversationId } = teamsFields;

// The key every part of a message starts with.
export const messageKey = {
  accountId,
  conversationId,
  threadId: { ...id, description: 'The message’s thread (messages.threadId).' },
  messageId: { ...id, description: 'The message (messages.id).' },
} as const;

export type MessageKey = RecordDraft<typeof messageKey>;

// One part of a message, under its message's key.
export type Part<Child> = {
  readonly key: MessageKey;
  readonly child: Child;
};

// A stream of the parts of each message, such as its reactions: they are
// read, kept and deleted with their message, so a part removed from a message
// the app still holds is deleted, and the parts of a message the app dropped
// from its cache stay.
export abstract class MessageChildStream<
  P extends Properties,
  Child,
> extends TeamsStream<P, Part<Child>> {
  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(
      key.accountId,
      key.conversationId,
      key.threadId,
      key.messageId,
    );
  }

  protected rows(scan: TeamsScan): readonly Part<Child>[] {
    return scan.clients.flatMap((client) =>
      scan.messages(client).flatMap((message) =>
        this.children(message).map((child) => ({
          key: {
            accountId: client.account.userId,
            conversationId: message.conversationId,
            threadId: message.threadId,
            messageId: message.id,
          },
          child,
        })),
      ),
    );
  }

  protected abstract children(message: TeamsMessage): readonly Child[];
}
