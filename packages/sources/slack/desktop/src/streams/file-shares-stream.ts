import type { RecordDraft } from '@eltjs/elt';
import type { SlackFileShare } from '@eltjs/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, ordinal, nullableText } = slackFields;

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
    description:
      'Whether the file lists the share with its private shares, those in private conversations, or with its public ones.',
  },
  position: {
    ...ordinal,
    description:
      'Its place in the file’s list of private or public shares in the conversation, from 0.',
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
  readonly primaryKey = [
    'workspaceId',
    'fileId',
    'isPrivate',
    'channelId',
    'position',
  ];
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per entry of a file’s lists of shares: the conversation and the message that shared it, including messages the app does not hold. A share a list repeats has a record for each place. Primary key workspaceId, fileId, isPrivate, channelId, position. Kept after the app drops the file.',
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
