import type { RecordDraft } from '@eltjs/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText } = teamsFields;

const properties = {
  accountId,
  store: {
    ...id,
    description:
      'The manager and object store of the Teams client that keeps the definition: user-installed-apps-manager/user-app-definitions, chat-installed-apps-manager/app-definitions or team-installed-apps-manager/app-definitions.',
  },
  cacheKey: {
    ...id,
    description: 'The definition’s key in that store, <appId>_<version>.',
  },
  appId: {
    ...id,
    description: 'The app’s ID in the Teams app store (installedApps.appId).',
  },
  version: { ...nullableText, description: 'The version it defines.' },
  name: { ...nullableText, description: 'The app’s name.' },
  developerName: { ...nullableText, description: 'Who makes it.' },
} as const;

type Row = RecordDraft<typeof properties>;

export class AppDefinitionsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'appDefinitions';
  readonly primaryKey = ['accountId', 'store', 'cacheKey'];
  // The managers cache the definitions of the apps they show and drop them
  // without a trace, so a definition gone from them was not deleted.
  override readonly emitsDeletes = undefined;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per definition of an app that a manager of the app has cached: each manager defines an app apart, and one can define it in several versions, so an appId can have several records. Primary key accountId, store, cacheKey. Every definition held stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, appDefinitions }) =>
      appDefinitions.map((definition) => ({
        accountId: account.userId,
        ...definition,
      })),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
