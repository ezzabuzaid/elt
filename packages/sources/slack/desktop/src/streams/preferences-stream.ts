import type { RecordDraft } from '@workspace/elt';
import type { SlackPreference } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  scope: {
    type: 'string',
    enum: ['user', 'team'],
    description:
      'user for the signed-in user’s own preference, team for the workspace’s as its admins set it.',
  },
  name: {
    ...id,
    description: 'Slack’s name for the preference, such as tz or time24.',
  },
  value: {
    type: 'string',
    description: 'Its value as JSON, as Slack holds it.',
  },
} as const;

type Row = {
  readonly workspaceId: string;
  readonly preference: SlackPreference;
};

export class PreferencesStream extends SlackDesktopStream<
  typeof properties,
  Row
> {
  readonly name = 'preferences';
  readonly primaryKey = ['workspaceId', 'scope', 'name'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per preference the app holds for a workspace: the user’s settings and the workspace’s. Primary key workspaceId, scope, name. One the app stops holding is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, preferences }) =>
      preferences.map((preference) => ({
        workspaceId: workspace.id,
        preference,
      })),
    );
  }

  protected records({
    workspaceId,
    preference,
  }: Row): RecordDraft<typeof properties>[] {
    return [
      {
        workspaceId,
        scope: preference.scope,
        name: preference.name,
        value: preference.valueJson,
      },
    ];
  }
}
