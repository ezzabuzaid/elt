import type { KeyValue, RecordDraft } from '@workspace/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText } = teamsFields;

const properties = {
  accountId,
  scope: {
    ...id,
    description: 'Where it is installed: user, chat or team.',
  },
  scopeId: {
    ...id,
    description:
      'The user (accounts.id), or the chat or team (conversations.id).',
  },
  appId: { ...id, description: 'The app’s ID in the Teams app store.' },
  state: {
    ...id,
    description:
      'Installed, InstalledAndPermanent (installed by the organization), InstalledAndDeprecated or InstalledAndHidden.',
  },
  version: { ...nullableText, description: 'The version installed.' },
  installedBy: {
    ...nullableText,
    description: 'Who installed it (people.mri).',
  },
  name: { ...nullableText, description: 'The app’s name.' },
  developerName: { ...nullableText, description: 'Who makes it.' },
} as const;

type Row = RecordDraft<typeof properties>;

export class InstalledAppsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'installedApps';
  readonly primaryKey = ['accountId', 'scope', 'scopeId', 'appId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per app installed for the user, or in a chat or team whose apps the app has loaded. Primary key accountId, scope, scopeId, appId. An app uninstalled where the app still holds the list is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holdsApps(key.accountId, key.scope, key.scopeId);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, installedApps }) =>
      installedApps.map((app) => ({ accountId: account.userId, ...app })),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
