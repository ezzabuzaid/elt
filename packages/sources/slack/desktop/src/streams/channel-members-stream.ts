import type { RecordDraft } from '@workspace/elt';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  memberId: { ...id, description: 'A member of it (members.id).' },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly memberId: string;
};

export class ChannelMembersStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'channelMembers';
  readonly primaryKey = ['workspaceId', 'channelId', 'memberId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per member of a conversation whose members the app keeps, which it does for group direct messages. Primary key workspaceId, channelId, memberId. A member the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, channels }) =>
      channels
        .filter(({ id }) => scan.channelSelected(id))
        .flatMap(({ id: channelId, memberIds }) =>
          [...new Set(memberIds)].map((memberId) => ({
            workspaceId: workspace.id,
            channelId,
            memberId,
          })),
        ),
    );
  }

  protected records(row: Row): RecordDraft<typeof properties>[] {
    return [row];
  }
}
