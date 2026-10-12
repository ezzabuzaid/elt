import type { RecordDraft } from '@workspace/elt';
import type { TeamsFolder } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, nullableText, nullableBoolean, nullableInstant } =
  teamsFields;

const properties = {
  accountId,
  id: { ...id, description: 'Teams’ ID for the folder.' },
  name: { ...nullableText, description: 'Its name.' },
  folderType: {
    ...nullableText,
    description:
      'UserCreated for the user’s own, or the kind Teams keeps, such as Favorites, Chats, TeamsAndChannels or EngageCommunities.',
  },
  sortType: {
    ...nullableText,
    description: 'How it orders its conversations, such as MostRecent.',
  },
  emoji: { ...nullableText, description: 'The emoji the user gave it.' },
  isHidden: { ...nullableBoolean, description: 'Whether it is hidden.' },
  isDeleted: { ...nullableBoolean, description: 'Whether it was deleted.' },
  createdAt: { ...nullableInstant, description: 'When it was created.' },
} as const;

type Row = { readonly accountId: string; readonly folder: TeamsFolder };

export class FoldersStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'folders';
  readonly primaryKey = ['accountId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per folder of the account’s chat list. Primary key accountId, id. A folder Teams no longer lists is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, folders }) =>
      folders.map((folder) => ({ accountId: account.userId, folder })),
    );
  }

  protected records({
    accountId,
    folder: { conversations: _conversations, ...folder },
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...folder }];
  }
}
