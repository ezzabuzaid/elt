import type { RecordDraft } from '@eltjs/elt';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ordinal } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  position: {
    ...ordinal,
    description: 'Its place in the conversation’s member list, from 0.',
  },
  memberId: { ...id, description: 'A member of it (members.id).' },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly position: number;
  readonly memberId: string;
};

export class ChannelMembersStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'channelMembers';
  readonly primaryKey = ['workspaceId', 'channelId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per entry of the member list of a conversation whose members the app keeps, which it does for group direct messages. A member the list repeats has a record for each place. Primary key workspaceId, channelId, position. An entry the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, channels }) =>
      channels
        .filter(({ id }) => scan.channelSelected(id))
        .flatMap(({ id: channelId, memberIds }) =>
          memberIds.map((memberId, position) => ({
            workspaceId: workspace.id,
            channelId,
            position,
            memberId,
          })),
        ),
    );
  }

  protected records(row: Row): RecordDraft<typeof properties>[] {
    return [row];
  }
}
