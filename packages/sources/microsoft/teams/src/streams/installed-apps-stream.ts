import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@eltjs/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, position, nullableText } = teamsFields;

const properties = {
  accountId,
  store: {
    ...id,
    description:
      'The manager and object store of the Teams client that keeps the list: user-installed-apps-manager/user-app-entitlements, chat-installed-apps-manager/app-entitlements or team-installed-apps-manager/app-entitlements.',
  },
  cacheKey: {
    ...id,
    description:
      'The list’s key in that store, <Scope>_general_<locale>_<scopeId>.',
  },
  position: {
    ...position,
    description: 'The app’s place in the list, from 0.',
  },
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
} as const;

type Row = RecordDraft<typeof properties>;

export class InstalledAppsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'installedApps';
  readonly primaryKey = ['accountId', 'store', 'cacheKey', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per app installed for the user, or in a chat or team whose apps the app has loaded. Primary key accountId, store, cacheKey, position. appDefinitions names each app by appId. An app uninstalled where the app still holds the list is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(scan: TeamsScan, { key }: VanishedRecord): boolean {
    return scan.holdsApps(key.accountId, key.store, key.cacheKey);
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
