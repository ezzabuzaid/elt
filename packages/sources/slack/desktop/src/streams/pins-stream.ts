import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { SlackPin } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, nullableText, nullableTimestamp } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: {
    ...id,
    description: 'The conversation it is pinned in (channels.id).',
  },
  ts: {
    ...ts,
    description: 'The pinned message (messages.ts), held by the app or not.',
  },
  type: { ...id, description: 'What is pinned: message.' },
  pinnedBy: {
    ...nullableText,
    description:
      'Who pinned it (members.id); NULL when the app holds neither the conversation’s pin list with the message nor the message.',
  },
  pinnedAt: {
    ...nullableTimestamp,
    description: 'When it was pinned; NULL as pinnedBy.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly pin: SlackPin };

export class PinsStream extends SlackDesktopStream<typeof properties, Row> {
  readonly name = 'pins';
  readonly primaryKey = ['workspaceId', 'channelId', 'ts'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per message pinned in a conversation, as far as the app knows the conversation’s pins. Primary key workspaceId, channelId, ts. A pin removed from a conversation whose pin list the app loaded is deleted; pins of a conversation it never loaded the list of stay.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: SlackDesktopScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holdsPins(key.workspaceId, key.channelId);
  }

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, pins }) =>
      pins
        .filter(({ channelId }) => scan.channelSelected(channelId))
        .map((pin) => ({ workspaceId: workspace.id, pin })),
    );
  }

  protected records({
    workspaceId,
    pin,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ workspaceId, ...pin }];
  }
}
