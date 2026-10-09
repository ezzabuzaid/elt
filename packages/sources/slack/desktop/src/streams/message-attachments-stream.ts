import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { SlackAttachment } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, ts, ordinal, nullableText, nullableBoolean } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  channelId: { ...id, description: 'The conversation (channels.id).' },
  messageTs: { ...ts, description: 'The message it is under (messages.ts).' },
  position: {
    ...ordinal,
    description: 'Its place under the message, from 0.',
  },
  attachmentId: { ...nullableText, description: 'Slack’s ID for it.' },
  fallback: {
    ...nullableText,
    description: 'Its plain-text summary.',
  },
  pretext: { ...nullableText, description: 'Text shown above it.' },
  text: { ...nullableText, description: 'Its text.' },
  fromUrl: {
    ...nullableText,
    description: 'The link it previews, for a link unfurl.',
  },
  authorId: {
    ...nullableText,
    description: 'For a shared message, who wrote it (members.id).',
  },
  authorName: { ...nullableText, description: 'Its author’s name.' },
  authorLink: { ...nullableText, description: 'Its author’s link.' },
  sharedChannelId: {
    ...nullableText,
    description: 'For a shared message, the conversation it came from.',
  },
  sharedMessageTs: {
    ...nullableText,
    description: 'For a shared message, its ts there.',
  },
  footer: { ...nullableText, description: 'Its footer.' },
  color: { ...nullableText, description: 'The color of its side bar.' },
  appId: { ...nullableText, description: 'The app that added it (apps.id).' },
  botId: { ...nullableText, description: 'The bot that added it (bots.id).' },
  isMessageUnfurl: {
    ...nullableBoolean,
    description: 'Whether it previews another Slack message.',
  },
  isAppUnfurl: {
    ...nullableBoolean,
    description: 'Whether an app added the preview.',
  },
  fields: {
    ...nullableText,
    description: 'Its title/value fields as JSON, as Slack holds them.',
  },
  blocks: {
    ...nullableText,
    description: 'Its Block Kit blocks as JSON, as Slack holds them.',
  },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly position: number;
  readonly attachment: SlackAttachment;
};

export class MessageAttachmentsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'messageAttachments';
  readonly primaryKey = ['workspaceId', 'channelId', 'messageTs', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per attachment Slack shows under a message: link previews, shared messages and integrations’ cards. Primary key workspaceId, channelId, messageTs, position. Kept and deleted with their message.',
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
      scan.messages(client).flatMap(({ channelId, ts, attachments }) =>
        attachments.map((attachment, position) => ({
          workspaceId: client.workspace.id,
          channelId,
          messageTs: ts,
          position,
          attachment,
        })),
      ),
    );
  }

  protected records({
    attachment,
    ...row
  }: Row): RecordDraft<typeof properties>[] {
    return [
      {
        ...row,
        attachmentId: attachment.id,
        fallback: attachment.fallback,
        pretext: attachment.pretext,
        text: attachment.text,
        fromUrl: attachment.fromUrl,
        authorId: attachment.authorId,
        authorName: attachment.authorName,
        authorLink: attachment.authorLink,
        sharedChannelId: attachment.channelId,
        sharedMessageTs: attachment.messageTs,
        footer: attachment.footer,
        color: attachment.color,
        appId: attachment.appId,
        botId: attachment.botId,
        isMessageUnfurl: attachment.isMessageUnfurl,
        isAppUnfurl: attachment.isAppUnfurl,
        fields: attachment.fieldsJson,
        blocks: attachment.blocksJson,
      },
    ];
  }
}
