import type { RecordDraft } from '@workspace/elt';
import type { SlackBot } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableText, nullableBoolean, nullableTimestamp } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  id: { ...id, description: 'Slack’s bot ID, such as B0123ABCD.' },
  name: { ...nullableText, description: 'The bot’s name.' },
  appId: { ...nullableText, description: 'The app it belongs to (apps.id).' },
  isDeleted: { ...nullableBoolean, description: 'Whether it was removed.' },
  updatedAt: {
    ...nullableTimestamp,
    description: 'When Slack last changed the bot.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly bot: SlackBot };

export class BotsStream extends SlackDesktopStream<typeof properties, Row> {
  readonly name = 'bots';
  readonly primaryKey = ['workspaceId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per bot the app knows in a workspace, such as the sender of an integration’s messages (messages.botId). Primary key workspaceId, id. One the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, bots }) =>
      bots.map((bot) => ({ workspaceId: workspace.id, bot })),
    );
  }

  protected records({
    workspaceId,
    bot,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ workspaceId, ...bot }];
  }
}
