import type { VanishedRecord } from '@zukhruf/snapshot-differential';

import type { RecordDraft } from '@eltjs/elt';
import type { TeamsMessage } from '@eltjs/sdk-microsoft-teams';

import type { TeamsScan } from '../teams-scan.ts';
import { TeamsStream, teamsFields } from '../teams-stream.ts';
import { messagePlace, messagePlaceKey } from './message-child-stream.ts';

const { id, instant, nullableInstant, nullableText, nullableBoolean } =
  teamsFields;

const properties = {
  ...messagePlace,
  threadId: {
    ...id,
    description:
      'The thread it starts or belongs to (messages.id of its first message): the message itself, except for a reply in a channel.',
  },
  id: {
    ...id,
    description:
      'Teams’ ID for the message within its conversation: when the service received it, in milliseconds since 1970. The app can keep one message in several places, each a record of its own.',
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
  readonly primaryKey = messagePlaceKey;
  readonly expiresBy = 'sentAt';
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per place the app keeps a chat or channel message: each entry of a reply chain it has held, and each conversation’s copy of its newest message and of its newest that is not a change to the conversation. Teams keeps only the parts of each conversation it loaded, so older history is here only if it was loaded while this import ran. Primary key accountId, store, conversationId, recordId, entry; one message (conversationId, id) can have several records. A message the app no longer lists inside a part of the conversation it still holds was deleted and is deleted here; one the app dropped from its cache stays. A conversation’s copy is replaced when its newest message changes.',
    properties,
    required: Object.keys(properties),
  } as const;

  override covers(
    scan: TeamsScan,
    { key, expiresBy }: VanishedRecord,
  ): boolean {
    return scan.holdsMessage(key, expiresBy);
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
      place,
      reactions: _reactions,
      mentions: _mentions,
      files: _files,
      links: _links,
      quotes: _quotes,
      ...message
    },
  }: Row): RecordDraft<typeof properties>[] {
    return [{ accountId, ...place, ...message }];
  }
}
