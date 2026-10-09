import type { RecordDraft } from '@workspace/elt';
import type { SlackFileShare } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, nullableText } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  fileId: { ...id, description: 'The file (files.id).' },
  channelId: {
    ...id,
    description: 'The conversation it was shared in (channels.id).',
  },
  ts: {
    ...ts,
    description:
      'The message that shared it (messages.ts), held by the app or not.',
  },
  isPrivate: {
    type: 'boolean',
    description: 'Whether the conversation is private.',
  },
  sharedBy: { ...nullableText, description: 'Who shared it (members.id).' },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly fileId: string;
  readonly share: SlackFileShare;
};

// Shares come with their file, which the app may drop: they stay with it.
export class FileSharesStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'fileShares';
  readonly primaryKey = ['workspaceId', 'fileId', 'channelId', 'ts'];
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place a file was shared: the conversation and the message that shared it, including messages the app does not hold. Primary key workspaceId, fileId, channelId, ts. Kept after the app drops the file.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, files }) =>
      files.flatMap(({ id: fileId, shares }) =>
        shares
          .filter(({ channelId }) => scan.channelSelected(channelId))
          .map((share) => ({ workspaceId: workspace.id, fileId, share })),
      ),
    );
  }

  protected records({ share, ...row }: Row): RecordDraft<typeof properties>[] {
    return [{ ...row, ...share }];
  }
}
