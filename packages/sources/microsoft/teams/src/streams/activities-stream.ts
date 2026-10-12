import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { TeamsActivity } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, instant, nullableText, nullableBoolean } = teamsFields;

const properties = {
  accountId,
  feed: {
    ...id,
    description:
      'notifications for the activity feed, annotations for reactions to the user’s messages.',
  },
  id: {
    ...id,
    description:
      'The entry’s ID in its feed, when it arrived in milliseconds since 1970.',
  },
  activityId: {
    ...nullableText,
    description: 'The activity service’s ID for it.',
  },
  type: {
    ...id,
    description:
      'What happened, such as mention, mentionInChat, reactionInChat, call, or msGraph for an app’s notice.',
  },
  subtype: { ...nullableText, description: 'Teams’ finer kind of it.' },
  occurredAt: { ...instant, description: 'When it happened.' },
  sourceConversationId: {
    ...nullableText,
    description: 'The conversation it happened in (conversations.id).',
  },
  sourceThreadId: {
    ...nullableText,
    description: 'The thread there (messages.threadId).',
  },
  sourceMessageId: {
    ...nullableText,
    description: 'The message it is about (messages.id).',
  },
  sourceUserId: {
    ...nullableText,
    description: 'Who did it (people.mri).',
  },
  sourceUserName: { ...nullableText, description: 'Their name.' },
  sourceTopic: {
    ...nullableText,
    description: 'The name of the conversation it happened in.',
  },
  preview: {
    ...nullableText,
    description: 'The text the feed shows for it.',
  },
  isRead: {
    ...nullableBoolean,
    description: 'Whether the user has opened it in the activity feed.',
  },
} as const;

type Row = { readonly accountId: string; readonly activity: TeamsActivity };

export class ActivitiesStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'activities';
  readonly primaryKey = ['accountId', 'feed', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per entry of the account’s activity feed, and of the reactions to the user’s messages, that the app holds. Primary key accountId, feed, id. An entry removed from the part of a feed the app still holds is deleted; one the app dropped from its cache stays.',
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
    return scan.clients.flatMap(({ account, activities }) =>
      activities.map((activity) => ({ accountId: account.userId, activity })),
    );
  }

  protected records({
    accountId,
    activity,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...activity }];
  }
}
