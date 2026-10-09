import type { RecordDraft } from '@workspace/elt';
import type { SlackUserGroupMembership } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableBoolean } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  userGroupId: {
    ...id,
    description: 'Slack’s user group ID, such as S0123ABCD.',
  },
  isMember: {
    ...nullableBoolean,
    description: 'Whether the signed-in user is in the group.',
  },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly membership: SlackUserGroupMembership;
};

// The app records each check of the user's membership it made, not a list of
// groups, so a check it no longer keeps says nothing: the stream deletes none.
export class UserGroupMembershipsStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'userGroupMemberships';
  readonly primaryKey = ['workspaceId', 'userGroupId'];
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per user group the app checked the signed-in user’s membership of. The app keeps neither the groups’ names nor their members. Primary key workspaceId, userGroupId. A group stays after the app forgets its check.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, userGroupMemberships }) =>
      userGroupMemberships.map((membership) => ({
        workspaceId: workspace.id,
        membership,
      })),
    );
  }

  protected records({
    workspaceId,
    membership,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ workspaceId, ...membership }];
  }
}
