import type { RecordDraft } from '@workspace/elt';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ordinal } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  sectionId: { ...id, description: 'The section (channelSections.id).' },
  channelId: { ...id, description: 'A conversation in it (channels.id).' },
  position: { ...ordinal, description: 'Its place in the section, from 0.' },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly sectionId: string;
  readonly channelId: string;
  readonly position: number;
};

export class ChannelSectionChannelsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'channelSectionChannels';
  readonly primaryKey = ['workspaceId', 'sectionId', 'channelId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per conversation the user put in a sidebar section. Slack’s own sections, which sort conversations themselves, list none. Primary key workspaceId, sectionId, channelId. One moved out is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, channelSections }) =>
      channelSections.flatMap(({ id: sectionId, channelIds }) =>
        [...new Set(channelIds)]
          .map((channelId, position) => ({
            workspaceId: workspace.id,
            sectionId,
            channelId,
            position,
          }))
          .filter(({ channelId }) => scan.channelSelected(channelId)),
      ),
    );
  }

  protected records(row: Row): RecordDraft<typeof properties>[] {
    return [row];
  }
}
