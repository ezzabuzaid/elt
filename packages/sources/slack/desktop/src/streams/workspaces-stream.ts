import type { KeyValue, RecordDraft } from '@workspace/elt';
import type { SlackClient } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableText, nullableTimestamp } = slackFields;

const properties = {
  id: { ...id, description: 'Slack’s workspace (team) ID, such as T0123ABCD.' },
  name: { ...id, description: 'The workspace’s name.' },
  domain: {
    ...id,
    description: 'The workspace’s subdomain: <domain>.slack.com.',
  },
  url: { ...nullableText, description: 'The workspace’s address.' },
  emailDomain: {
    ...nullableText,
    description: 'The email domain that may join the workspace on its own.',
  },
  plan: {
    ...nullableText,
    description:
      'Slack’s code for the workspace’s plan, such as plus; NULL for the free plan.',
  },
  createdAt: {
    ...nullableTimestamp,
    description: 'When the workspace was created.',
  },
  iconUrl: { ...nullableText, description: 'The workspace icon’s URL.' },
  userId: {
    ...id,
    description: 'The member ID this Mac is signed in to the workspace as.',
  },
} as const;

export class WorkspacesStream extends SlackDesktopStream<
  typeof properties,
  SlackClient
> {
  readonly name = 'workspaces';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per Slack workspace the app is signed in to on this Mac and has saved. Primary key id. A workspace the app no longer keeps, such as one signed out of, stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: SlackDesktopScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.keeps(key.id);
  }

  protected rows(scan: SlackDesktopScan): readonly SlackClient[] {
    return scan.clients;
  }

  protected records({
    workspace,
    userId,
  }: SlackClient): RecordDraft<typeof properties>[] {
    return [{ ...workspace, userId }];
  }
}
