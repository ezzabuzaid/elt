import type { RecordDraft } from '@workspace/elt';
import type { SlackThreadSubscription } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, nullableBoolean, nullableTs } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  threadTs: { ...ts, description: 'The thread’s parent (messages.ts).' },
  isSubscribed: {
    ...nullableBoolean,
    description: 'Whether the user follows the thread.',
  },
  lastReadTs: {
    ...nullableTs,
    description: 'The newest reply the user has read, as a ts.',
  },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly subscription: SlackThreadSubscription;
};

export class ThreadSubscriptionsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'threadSubscriptions';
  readonly primaryKey = ['workspaceId', 'channelId', 'threadTs'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per thread the app knows whether the user follows. Primary key workspaceId, channelId, threadTs. One the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, threadSubscriptions }) =>
      threadSubscriptions
        .filter(({ channelId }) => scan.channelSelected(channelId))
        .map((subscription) => ({ workspaceId: workspace.id, subscription })),
    );
  }

  protected records({
    workspaceId,
    subscription,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ workspaceId, ...subscription }];
  }
}
