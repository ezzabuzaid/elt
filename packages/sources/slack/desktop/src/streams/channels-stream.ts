import type { RecordDraft } from '@workspace/elt';
import type { SlackChannel } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const {
  id,
  nullableText,
  nullableBoolean,
  nullableTimestamp,
  textList,
  nullableTs,
} = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  id: {
    ...id,
    description:
      'Slack’s conversation ID: C… for channels, G… for some private ones, D… for direct messages.',
  },
  name: {
    ...nullableText,
    description:
      'The channel’s name without #; for a group direct message, Slack’s generated mpdm- name.',
  },
  kind: {
    type: 'string',
    enum: ['public', 'private', 'im', 'mpim'],
    description:
      'public or private channel, im (a direct message with one person) or mpim (a group direct message).',
  },
  imUserId: {
    ...nullableText,
    description: 'For an im, the other person (members.id).',
  },
  createdAt: { ...nullableTimestamp, description: 'When it was created.' },
  creatorId: {
    ...nullableText,
    description: 'Who created it (members.id).',
  },
  updatedAt: {
    ...nullableTimestamp,
    description: 'When Slack last changed the channel itself.',
  },
  isArchived: { ...nullableBoolean, description: 'Whether it is archived.' },
  isGeneral: {
    ...nullableBoolean,
    description: 'Whether it is the workspace’s general channel.',
  },
  isMember: {
    ...nullableBoolean,
    description: 'Whether the signed-in user belongs to it.',
  },
  isExternallyShared: {
    ...nullableBoolean,
    description:
      'Whether it is shared with another organization (Slack Connect).',
  },
  isOrgShared: {
    ...nullableBoolean,
    description: 'Whether it is shared across workspaces of one organization.',
  },
  topic: { ...nullableText, description: 'The channel’s topic.' },
  topicSetBy: {
    ...nullableText,
    description: 'Who set the topic (members.id).',
  },
  topicSetAt: { ...nullableTimestamp, description: 'When the topic was set.' },
  purpose: { ...nullableText, description: 'The channel’s description.' },
  purposeSetBy: {
    ...nullableText,
    description: 'Who set the description (members.id).',
  },
  purposeSetAt: {
    ...nullableTimestamp,
    description: 'When the description was set.',
  },
  previousNames: {
    ...textList,
    description: 'Names the channel had before, newest first.',
  },
  lastReadTs: {
    ...nullableTs,
    description:
      'The newest message the signed-in user has read (messages.ts); NULL when the app has none.',
  },
  latestTs: {
    ...nullableTs,
    description:
      'The newest message in the channel as the app last heard (messages.ts), even when the app holds no messages of it.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly channel: SlackChannel };

export class ChannelsStream extends SlackDesktopStream<typeof properties, Row> {
  readonly name = 'channels';
  readonly primaryKey = ['workspaceId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per conversation the app knows in a workspace: channels the user can see, direct messages and group direct messages. Primary key workspaceId, id. One the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, channels }) =>
      channels
        .filter(({ id }) => scan.channelSelected(id))
        .map((channel) => ({ workspaceId: workspace.id, channel })),
    );
  }

  protected records({
    workspaceId,
    channel,
  }: Row): RecordDraft<typeof properties>[] {
    return [
      {
        workspaceId,
        id: channel.id,
        name: channel.name,
        kind: channel.kind,
        imUserId: channel.imUserId,
        createdAt: channel.createdAt,
        creatorId: channel.creatorId,
        updatedAt: channel.updatedAt,
        isArchived: channel.isArchived,
        isGeneral: channel.isGeneral,
        isMember: channel.isMember,
        isExternallyShared: channel.isExternallyShared,
        isOrgShared: channel.isOrgShared,
        topic: channel.topic.value,
        topicSetBy: channel.topic.setBy,
        topicSetAt: channel.topic.setAt,
        purpose: channel.purpose.value,
        purposeSetBy: channel.purpose.setBy,
        purposeSetAt: channel.purpose.setAt,
        previousNames: [...channel.previousNames],
        lastReadTs: channel.lastReadTs,
        latestTs: channel.latestTs,
      },
    ];
  }
}
