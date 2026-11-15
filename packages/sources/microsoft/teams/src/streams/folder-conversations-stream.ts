import type { RecordDraft } from '@eltjs/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, accountId, position, conversationId, nullableInstant } =
  teamsFields;

const properties = {
  accountId,
  folderId: { ...id, description: 'The folder (folders.id).' },
  position: {
    ...position,
    description: 'The conversation’s place in the folder’s list, from 0.',
  },
  conversationId,
  addedAt: {
    ...nullableInstant,
    description: 'When the conversation was put in the folder.',
  },
} as const;

type Row = RecordDraft<typeof properties>;

export class FolderConversationsStream extends TeamsStream<
  typeof properties,
  Row
> {
  readonly name = 'folderConversations';
  readonly primaryKey = ['accountId', 'folderId', 'position'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place in the list of conversations of a folder of the chat list. Primary key accountId, folderId, position. A conversation taken out of a folder is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, folders }) =>
      folders.flatMap(({ id, conversations }) =>
        conversations
          .filter(({ conversationId }) =>
            scan.conversationSelected(conversationId),
          )
          .map((conversation) => ({
            accountId: account.userId,
            folderId: id,
            ...conversation,
          })),
      ),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
