import type { RecordDraft } from '@eltjs/elt';

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
  readonly primaryKey = ['workspaceId', 'sectionId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per entry of the list of conversations the user put in a sidebar section. Slack’s own sections, which sort conversations themselves, list none. A conversation the list repeats has a record for each place. Primary key workspaceId, sectionId, position. An entry the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, channelSectionLists }) =>
      channelSectionLists.flatMap(({ sectionId, channelIds }) =>
        channelIds
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
