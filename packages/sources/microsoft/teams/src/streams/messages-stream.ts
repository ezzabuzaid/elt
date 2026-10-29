import type { KeyValue } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@workspace/elt';
import type { TeamsMessage } from '@workspace/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';

const {
  id,
  accountId,
  conversationId,
  instant,
  nullableInstant,
  nullableText,
  nullableBoolean,
} = teamsFields;

const properties = {
  accountId,
  conversationId,
  threadId: {
    ...id,
    description:
      'The thread it starts or belongs to (messages.id of its first message): the message itself, except for a reply in a channel.',
  },
  id: {
    ...id,
    description:
      'Teams’ ID for the message within its conversation: when the service received it, in milliseconds since 1970.',
  },
  sentAt: { ...instant, description: 'When the service received it.' },
  senderId: {
    ...nullableText,
    description:
      'Who sent it: 8:orgid:<id> for a person (people.mri), 28:<id> for a bot.',
  },
  senderName: {
    ...nullableText,
    description: 'The sender’s name as the message carries it.',
  },
  messageType: {
    ...id,
    description:
      'Teams’ kind of message, such as RichText/Html or Text for what people write, Event/Call, RichText/Media_CallRecording, or ThreadActivity/AddMember for a change to the conversation.',
  },
  contentType: {
    ...nullableText,
    description: 'How content is written, such as Text or RichText/Html.',
  },
  content: {
    ...nullableText,
    description:
      'The message as Teams holds it: HTML for rich text, XML for events; NULL once deleted.',
  },
  subject: {
    ...nullableText,
    description: 'The subject a channel post was given.',
  },
  importance: {
    ...nullableText,
    description: 'high or urgent when the sender marked it so.',
  },
  editedAt: { ...nullableInstant, description: 'When it was last edited.' },
  deletedAt: {
    ...nullableInstant,
    description: 'When it was deleted; Teams keeps a deleted message’s place.',
  },
  isFromUser: {
    ...nullableBoolean,
    description:
      'Whether the account’s user sent it; NULL for a message Teams keeps only as a conversation’s newest.',
  },
  cardsJson: {
    ...nullableText,
    description: 'The adaptive cards it carries, as the JSON Teams holds.',
  },
  pinnedBy: {
    ...nullableText,
    description: 'Who pinned it to the conversation (people.mri).',
  },
  pinnedAt: { ...nullableInstant, description: 'When it was pinned.' },
} as const;

type Row = { readonly accountId: string; readonly message: TeamsMessage };

export class MessagesStream extends TeamsStream<typeof properties, Row> {
  readonly name = 'messages';
  readonly primaryKey = ['accountId', 'conversationId', 'threadId', 'id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per chat and channel message the app has held, and the newest message of every conversation: Teams keeps only the parts of each conversation it loaded, so older history is here only if it was loaded while this import ran. Primary key accountId, conversationId, threadId, id. A message the app no longer lists inside a part of the conversation it still holds was deleted and is deleted here; one the app dropped from its cache stays.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    key: Readonly<Record<string, KeyValue>>,
  ): boolean {
    return scan.holds(key.accountId, key.conversationId, key.threadId, key.id);
  }

  protected rows(scan: TeamsScan): readonly Row[] {
    return scan.clients.flatMap((client) =>
      scan
        .messages(client)
        .map((message) => ({ accountId: client.account.userId, message })),
    );
  }

  protected records({
    accountId,
    message: {
      reactions: _reactions,
      mentions: _mentions,
      files: _files,
      links: _links,
      quotes: _quotes,
      ...message
    },
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...message }];
  }
}
