import type { KeyValue } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@workspace/elt';
import type { TeamsSavedMessage } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, instant, nullableText } = teamsFields;

const properties = {
  accountId,
  feed: {
    ...id,
    description:
      'saved, or starred for a message saved before Teams named it so.',
  },
  id: {
    ...id,
    description:
      'The entry’s ID in Teams’ saved list, when it was saved in milliseconds since 1970.',
  },
  conversationId: {
    ...nullableText,
    description: 'The saved message’s conversation (conversations.id).',
  },
  threadId: {
    ...nullableText,
    description: 'Its thread (messages.threadId).',
  },
  messageId: {
    ...nullableText,
    description: 'The saved message (messages.id).',
  },
  savedAt: { ...instant, description: 'When the user saved it.' },
} as const;

type Row = { readonly accountId: string; readonly saved: TeamsSavedMessage };

export class SavedMessagesStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'savedMessages';
  readonly primaryKey = ['accountId', 'feed', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per message the user saved, that the app holds. Primary key accountId, feed, id. A message unsaved inside the part of the list the app still holds is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(key.accountId, `48:${String(key.feed)}`, key.id, key.id);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, savedMessages }) =>
      savedMessages.map((saved) => ({ accountId: account.userId, saved })),
    );
  }

  protected records({
    accountId,
    saved,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...saved }];
  }
}
