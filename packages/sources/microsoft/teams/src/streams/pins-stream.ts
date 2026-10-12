import type { RecordDraft } from '@workspace/elt';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const { id, position, accountId, conversationId } = teamsFields;

const properties = {
  accountId,
  conversationId,
  messageId: {
    ...id,
    description:
      'The pinned message (messages.id), which messages holds when the app has loaded it, with who pinned it and when.',
  },
  position: {
    ...position,
    description: 'Its place among the conversation’s pins, from 0.',
  },
} as const;

type Row = RecordDraft<typeof properties>;

export class PinsStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'pins';
  readonly primaryKey = ['accountId', 'conversationId', 'messageId'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per message pinned to a conversation, as the conversation lists them. Primary key accountId, conversationId, messageId. An unpinned message is deleted.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap(({ account, conversations }) =>
      conversations
        .filter(({ id }) => scan.conversationSelected(id))
        .flatMap(({ id, pinnedMessageIds }) =>
          pinnedMessageIds.map((messageId, position) => ({
            accountId: account.userId,
            conversationId: id,
            messageId,
            position,
          })),
        ),
    );
  }

  protected records(row: Row): Row[] {
    return [row];
  }
}
