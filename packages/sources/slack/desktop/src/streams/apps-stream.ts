import type { RecordDraft } from '@workspace/elt';
import type { SlackApp } from '@workspace/sdk-slack-desktop';

import type { SlackDesktopScan } from '../slack-desktop-scan.ts';
import { SlackDesktopStream, slackFields } from '../slack-desktop-stream.ts';

const { id, nullableText, nullableBoolean } = slackFields;

const properties = {
  workspaceId: { ...id, description: 'The workspace (workspaces.id).' },
  id: { ...id, description: 'Slack’s app ID, such as A0123ABCD.' },
  name: { ...nullableText, description: 'The app’s name.' },
  description: { ...nullableText, description: 'What the app says it does.' },
  developerName: { ...nullableText, description: 'Who made it.' },
  appType: { ...nullableText, description: 'Slack’s kind of app.' },
  url: { ...nullableText, description: 'The app’s page.' },
  isInstalled: {
    ...nullableBoolean,
    description: 'Whether it is installed in the workspace.',
  },
  isDistributed: {
    ...nullableBoolean,
    description: 'Whether it is distributed to other workspaces.',
  },
  isWorkflowApp: {
    ...nullableBoolean,
    description: 'Whether it is a Workflow Builder app.',
  },
} as const;

type Row = { readonly workspaceId: string; readonly app: SlackApp };

export class AppsStream extends SlackDesktopStream<typeof properties, Row> {
  readonly name = 'apps';
  readonly primaryKey = ['workspaceId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per Slack app the app has loaded in a workspace. Primary key workspaceId, id. One the app stops listing is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: SlackDesktopScan): readonly Row[] {
    return scan.clients.flatMap(({ workspace, apps }) =>
      apps.map((app) => ({ workspaceId: workspace.id, app })),
    );
  }

  protected records({
    workspaceId,
    app,
  }: Row): RecordDraft<typeof properties>[] {
    return [{ workspaceId, ...app }];
  }
}
