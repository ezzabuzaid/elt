import { Fields } from './fields.ts';
import type {
  TeamsMention,
  TeamsMessage,
  TeamsMessageFile,
  TeamsMessageLink,
  TeamsQuote,
  TeamsReaction,
} from './teams-client.ts';

// A message as the reply chain cache holds it.
export function readMessage(message: Fields): TeamsMessage {
  return {
    conversationId: message.requiredString('conversationId'),
    threadId: message.requiredString('parentMessageId'),
    id: message.requiredString('id'),
    sentAt: message.requiredMilliseconds('originalArrivalTime'),
    senderId: message.string('creator'),
    senderName: message.string('imDisplayName'),
    messageType: message.requiredString('messageType'),
    contentType: message.string('contentType'),
    isFromUser: message.boolean('isSentByCurrentUser'),
    ...body(message),
  };
}

// The newest message of a conversation, which the conversation itself keeps
// in other names, whether or not its reply chain is cached. A channel names
// the message's thread in its link: conversation/<id>;messageid=<thread>.
export function readLastMessage(
  message: Fields,
  conversationId: string,
): TeamsMessage {
  const id = message.requiredString('id');
  const link = message.string('conversationLink');
  return {
    conversationId,
    threadId: (link && /;messageid=(\d+)$/.exec(link)?.[1]) ?? id,
    id,
    sentAt: message.requiredInstant('originalarrivaltime', 3),
    senderId: message.string('fromUserId'),
    senderName: message.string('imdisplayname'),
    messageType: message.requiredString('messagetype'),
    contentType: message.string('contenttype'),
    isFromUser: null,
    ...body(message),
  };
}

type Body = Omit<
  TeamsMessage,
  | 'conversationId'
  | 'threadId'
  | 'id'
  | 'sentAt'
  | 'senderId'
  | 'senderName'
  | 'messageType'
  | 'contentType'
  | 'isFromUser'
>;

function body(message: Fields): Body {
  const properties = message.object('properties');
  // Teams keeps {creatorId: '', pinnedTime: 0} on a message never pinned.
  const pinned = properties?.parsedObject('pinned');
  const pinnedAt = pinned?.milliseconds('pinnedTime') ?? null;
  return {
    content: message.string('content'),
    subject: properties?.string('subject') ?? null,
    importance: properties?.string('importance') ?? null,
    editedAt: properties?.milliseconds('edittime') ?? null,
    deletedAt:
      properties?.milliseconds('deletetime') ??
      properties?.milliseconds('hardDeleteTime') ??
      null,
    cardsJson: properties?.json('cards') ?? null,
    reactions: properties?.list('emotions').flatMap(reactions) ?? [],
    mentions: properties?.parsedList('mentions').map(mention) ?? [],
    files: properties?.parsedList('files').map(file) ?? [],
    links: properties?.parsedList('links').map(link) ?? [],
    quotes: properties?.list('qtdMsgs').map(quote) ?? [],
    pinnedBy: pinnedAt === null ? null : (pinned?.string('creatorId') ?? null),
    pinnedAt,
  };
}

function reactions(emotion: Fields): TeamsReaction[] {
  const emoji = emotion.requiredString('key');
  return emotion.list('users').map((user) => ({
    emoji,
    userId: user.requiredString('mri'),
    reactedAt: user.milliseconds('time'),
  }));
}

function mention(mention: Fields, index: number): TeamsMention {
  return {
    position: mention.number('itemid') ?? index,
    mentionedId: mention.requiredString('mri'),
    kind: mention.string('mentionType'),
    displayName: mention.string('displayName'),
  };
}

function file(file: Fields): TeamsMessageFile {
  const info = file.object('fileInfo');
  return {
    id: file.string('itemid') ?? file.requiredString('id'),
    name: file.string('fileName'),
    fileType: file.string('fileType'),
    title: file.string('title'),
    url: info?.string('fileUrl') ?? file.string('objectUrl'),
    siteUrl: info?.string('siteUrl') ?? null,
    shareUrl: info?.string('shareUrl') ?? null,
    service: file.object('fileChicletState')?.string('serviceName') ?? null,
  };
}

function link(link: Fields, position: number): TeamsMessageLink {
  const preview = link.object('preview');
  return {
    position,
    url: link.requiredString('url'),
    title: preview?.string('title') ?? null,
    description: preview?.string('description') ?? null,
    previewUrl: preview?.string('previewurl') ?? null,
  };
}

function quote(quote: Fields): TeamsQuote {
  return {
    messageId: quote.requiredText('messageId'),
    senderId: quote.string('sender'),
    sentAt: quote.milliseconds('time'),
    threadId: quote.string('replyChainId'),
  };
}
