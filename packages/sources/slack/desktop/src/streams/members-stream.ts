import type { RecordDraft } from '@workspace/elt';
import type { SlackMember } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableText, nullableBoolean, nullableTimestamp } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  id: { ...id, description: 'Slack’s member ID, such as U0123ABCD.' },
  teamId: {
    ...nullableText,
    description:
      'The workspace the member belongs to; another workspace’s ID for someone from a shared channel.',
  },
  name: { ...nullableText, description: 'The member’s username.' },
  realName: { ...nullableText, description: 'The member’s full name.' },
  displayName: {
    ...nullableText,
    description: 'The name the member chose to show.',
  },
  firstName: { ...nullableText, description: 'First name.' },
  lastName: { ...nullableText, description: 'Last name.' },
  title: { ...nullableText, description: 'Job title.' },
  email: { ...nullableText, description: 'Email address.' },
  phone: { ...nullableText, description: 'Phone number.' },
  pronouns: { ...nullableText, description: 'Pronouns.' },
  timeZone: {
    ...nullableText,
    description: 'IANA time zone, such as Europe/London.',
  },
  statusText: { ...nullableText, description: 'Custom status text.' },
  statusEmoji: {
    ...nullableText,
    description: 'Custom status emoji, such as :palm_tree:.',
  },
  statusExpiresAt: {
    ...nullableTimestamp,
    description: 'When the custom status clears; NULL when it does not.',
  },
  avatarUrl: { ...nullableText, description: 'Profile picture URL, 192 px.' },
  botId: {
    ...nullableText,
    description: 'For a bot user, its bot (bots.id).',
  },
  appId: {
    ...nullableText,
    description: 'For an app’s user, its app (apps.id).',
  },
  isBot: { ...nullableBoolean, description: 'Whether it is a bot.' },
  isAppUser: {
    ...nullableBoolean,
    description: 'Whether it is an app’s user.',
  },
  isDeleted: {
    ...nullableBoolean,
    description: 'Whether the member was deactivated.',
  },
  isAdmin: { ...nullableBoolean, description: 'Whether a workspace admin.' },
  isOwner: { ...nullableBoolean, description: 'Whether a workspace owner.' },
  isPrimaryOwner: {
    ...nullableBoolean,
    description: 'Whether the primary owner.',
  },
  isRestricted: {
    ...nullableBoolean,
    description: 'Whether a guest limited to some channels.',
  },
  isUltraRestricted: {
    ...nullableBoolean,
    description: 'Whether a guest limited to one channel.',
  },
  isInvited: {
    ...nullableBoolean,
    description: 'Whether invited and not yet joined.',
  },
  isSelf: {
    ...nullableBoolean,
    description: 'Whether it is the signed-in user.',
  },
  updatedAt: {
    ...nullableTimestamp,
    description: 'When Slack last changed the member’s profile.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly member: SlackMember };

export class MembersStream extends SlackDesktopStream<typeof properties, Row> {
  readonly name = 'members';
  readonly primaryKey = ['workspaceId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person, bot or app user the app knows in a workspace. Primary key workspaceId, id. One the app stops listing is deleted; a deactivated member stays with isDeleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, members }) =>
      members.map((member) => ({ workspaceId: workspace.id, member })),
    );
  }

  protected records({
    workspaceId,
    member,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ workspaceId, ...member }];
  }
}
