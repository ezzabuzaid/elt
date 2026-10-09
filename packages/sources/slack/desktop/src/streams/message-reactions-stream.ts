import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { SlackReaction } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, nullableText, textList } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  messageTs: { ...ts, description: 'The message (messages.ts).' },
  name: {
    ...id,
    description:
      'The emoji, as Slack names it, with any skin tone: thumbsup::skin-tone-2.',
  },
  baseName: {
    ...nullableText,
    description: 'The emoji without its skin tone.',
  },
  count: {
    type: 'integer',
    minimum: 1,
    description: 'How many people reacted with it.',
  },
  userIds: {
    ...textList,
    description:
      'Who reacted (members.id), as far as the app knows: on a busy message, fewer than count.',
  },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly reaction: SlackReaction;
};

export class MessageReactionsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'messageReactions';
  readonly primaryKey = ['workspaceId', 'channelId', 'messageTs', 'name'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per emoji reaction on a message. Primary key workspaceId, channelId, messageTs, name. A reaction removed from a message the app still holds is deleted; reactions of a message the app dropped from its cache stay.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: SlackDesktopScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(key.workspaceId, key.channelId, key.messageTs);
  }

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap((client) =>
      scan.messages(client).flatMap(({ channelId, ts, reactions }) =>
        reactions.map((reaction) => ({
          workspaceId: client.workspace.id,
          channelId,
          messageTs: ts,
          reaction,
        })),
      ),
    );
  }

  protected records({
    reaction,
    ...row
  }: Row): RecordDraft<typeof properties>[] {
    return [{ ...row, ...reaction, userIds: [...reaction.userIds] }];
  }
}
