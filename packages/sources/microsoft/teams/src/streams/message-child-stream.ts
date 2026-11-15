import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import type { Properties, RecordDraft } from '@eltjs/elt';
import type { TeamsMessage } from '@eltjs/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, conversationId, instant } = teamsFields;

// Where the Teams client keeps a message, which is its identity: the store
// keeps the record's key unique and the record keeps the entry's name unique.
// Teams' own id for the message is not unique there.
export const messagePlace = {
  accountId,
  store: {
    ...id,
    description:
      'The object store of the Teams client that keeps the message: replychain-manager/replychains, streams-replychain-manager/saved, or conversation-manager/conversations for the copy a conversation keeps of its newest message.',
  },
  conversationId,
  recordId: {
    ...id,
    description:
      'The record that keeps the message in that store: its reply chain, by the ID of the chain’s first message, or for a copy, its conversation.',
  },
  entry: {
    ...id,
    description:
      'The message’s name in that record: its key in the reply chain, or lastMessage or lastNonTMMessage for a copy.',
  },
} as const;

export const messagePlaceKey = [
  'accountId',
  'store',
  'conversationId',
  'recordId',
  'entry',
] as const;

// The key every part of a message starts with, and when its message was sent,
// which says whether the app still holds the message's place.
export const messageKey = {
  ...messagePlace,
  sentAt: { ...instant, description: 'When its message was sent.' },
} as const;

type MessageKey = RecordDraft<typeof messageKey>;

// One part of a message, under its message's key.
export type Part<Child> = {
  readonly key: MessageKey;
  readonly child: Child;
};

// A stream of the parts of each message, such as its reactions, each at its
// place in its message's list: they are read, kept and deleted with their
// message, so a part removed from a message the app still holds is deleted,
// and the parts of a message the app dropped from its cache stay.
export abstract class MessageChildStream<
  P extends Properties,
  Child,
> extends TeamsStream<P, Part<Child>> {
  readonly expiresBy = 'sentAt';

  override covers(
    scan: TeamsScan,
    { key, expiresBy }: VanishedRecord,
  ): boolean {
    return scan.holdsMessage(key, expiresBy);
  }

  protected rows(scan: TeamsScan): readonly Part<Child>[] {
    return scan.clients.flatMap((client) =>
      scan.messages(client).flatMap((message) =>
        this.children(message).map((child) => ({
          key: {
            accountId: client.account.userId,
            ...message.place,
            sentAt: message.sentAt,
          },
          child,
        })),
      ),
    );
  }

  protected abstract children(message: TeamsMessage): readonly Child[];
}
