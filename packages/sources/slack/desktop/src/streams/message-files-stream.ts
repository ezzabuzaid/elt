import type { KeyValue, RecordDraft } from '@workspace/elt';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, ordinal } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  messageTs: { ...ts, description: 'The message (messages.ts).' },
  position: { ...ordinal, description: 'Its place in the message, from 0.' },
  fileId: { ...id, description: 'The file (files.id).' },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly position: number;
  readonly fileId: string;
};

export class MessageFilesStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'messageFiles';
  readonly primaryKey = ['workspaceId', 'channelId', 'messageTs', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per file a message shares, in the message’s order. Primary key workspaceId, channelId, messageTs, position. Kept and deleted with their message.',
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
      scan.messages(client).flatMap(({ channelId, ts, fileIds }) =>
        fileIds.map((fileId, position) => ({
          workspaceId: client.workspace.id,
          channelId,
          messageTs: ts,
          position,
          fileId,
        })),
      ),
    );
  }

  protected records(row: Row): RecordDraft<typeof properties>[] {
    return [row];
  }
}
