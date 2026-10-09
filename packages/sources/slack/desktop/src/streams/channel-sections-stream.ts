import type { RecordDraft } from '@workspace/elt';
import type { SlackChannelSection } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ordinal, nullableText } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  id: { ...id, description: 'Slack’s section ID.' },
  type: {
    ...id,
    description:
      'Slack’s kind of section: standard for one the user made; channels, direct_messages, stars and the like for Slack’s own.',
  },
  name: {
    ...nullableText,
    description: 'The name the user gave it; NULL for Slack’s own sections.',
  },
  emoji: { ...nullableText, description: 'Its emoji.' },
  position: {
    ...ordinal,
    description: 'Where the sidebar shows it, from 0 at the top.',
  },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly section: SlackChannelSection;
};

export class ChannelSectionsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'channelSections';
  readonly primaryKey = ['workspaceId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per section of the user’s sidebar in a workspace. Primary key workspaceId, id. One the user removes is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, channelSections }) =>
      channelSections.map((section) => ({
        workspaceId: workspace.id,
        section,
      })),
    );
  }

  protected records({
    workspaceId,
    section,
  }: Row): RecordDraft<typeof properties>[] {
    return [
      {
        workspaceId,
        id: section.id,
        type: section.type,
        name: section.name,
        emoji: section.emoji,
        position: section.position,
      },
    ];
  }
}
