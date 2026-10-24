import type { RecordDraft, SchemaRecord } from '@workspace/elt';
import {
  type Message,
  messageMediaFile,
} from '@workspace/sdk-whatsapp-desktop';

import { WhatsAppMessageStream } from '../whatsapp-message-stream.ts';
import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { base64, whatsappFields } from '../whatsapp-stream.ts';

const {
  jid,
  nullableJid,
  text,
  boolean,
  integer,
  nullableInteger,
  nullableNumber,
  nullableText,
  nullableBoolean,
  nullableInstant,
  nullableBase64,
} = whatsappFields;
const media = (what: string, column: string) =>
  `${what} (ZWAMEDIAITEM.${column}); NULL when not stored.`;

const properties = {
  chatJid: {
    ...jid,
    description: 'The chat the message is in; refers to chats.jid.',
  },
  isFromMe: {
    ...boolean,
    description: 'Whether this account sent the message (ZISFROMME).',
  },
  stanzaId: {
    ...text,
    minLength: 1,
    description:
      'The ID its sender gave the message (ZSTANZAID); with chatJid and isFromMe, the primary key, as WhatsApp keys a message.',
  },
  senderJid: {
    ...nullableJid,
    description:
      'Who sent the message: the group member for a group message, the person for a message from one; NULL when this account sent it or WhatsApp records no person, as for a group notice or a channel post.',
  },
  fromJid: {
    ...nullableJid,
    description:
      'The JID WhatsApp records the message as from (ZFROMJID): the person, or the group, channel or broadcast for messages there; NULL on this account’s messages.',
  },
  toJid: {
    ...nullableJid,
    description:
      'The JID WhatsApp records the message as to (ZTOJID); set on this account’s messages.',
  },
  groupMemberJid: {
    ...nullableJid,
    description:
      'The group member who sent the message (ZGROUPMEMBER → ZWAGROUPMEMBER.ZMEMBERJID); NULL outside groups and for group notices.',
  },
  pushName: {
    ...nullableText,
    description: 'The name the sender gave WhatsApp when sending (ZPUSHNAME).',
  },
  messageDate: {
    ...nullableInstant,
    description: 'When the message was sent, UTC (ZMESSAGEDATE).',
  },
  sentDate: {
    ...nullableInstant,
    description: 'WhatsApp’s sent date, UTC (ZSENTDATE); set on few messages.',
  },
  messageType: {
    ...integer,
    description:
      'WhatsApp’s message kind (ZMESSAGETYPE), seen as: 0 text, 1 image, 2 video, 3 audio or voice note, 4 contact card, 5 location, 6 group notice, 7 link, 8 document, 14 a message deleted for everyone, which WhatsApp keeps with its content removed (in a group, text may name the admin who deleted it), 15 sticker. An edit rewrites the message in place. WhatsApp documents none of them; other codes stay numbers.',
  },
  groupEventType: {
    ...nullableInteger,
    description:
      'WhatsApp’s undocumented code for what a notice says (ZGROUPEVENTTYPE); 2 on ordinary messages.',
  },
  messageStatus: {
    ...nullableInteger,
    description:
      'WhatsApp’s delivery state (ZMESSAGESTATUS), seen as: 6 delivered, 8 read, 5 played (voice notes).',
  },
  messageErrorStatus: {
    ...nullableInteger,
    description: 'WhatsApp’s undocumented failure code (ZMESSAGEERRORSTATUS).',
  },
  flags: {
    ...nullableInteger,
    description: 'WhatsApp’s undocumented bit flags of the message (ZFLAGS).',
  },
  starred: {
    ...nullableBoolean,
    description: 'Whether the message is starred (ZSTARRED).',
  },
  sort: {
    ...nullableInteger,
    description: 'WhatsApp’s order of the message in its chat (ZSORT).',
  },
  text: {
    ...nullableText,
    description:
      'The message text, a link message’s text with its URL, a document’s caption, or a notice’s text (ZTEXT); NULL on images and videos, whose caption is title.',
  },
  childMessagesDeliveredCount: {
    ...nullableInteger,
    description:
      'For a broadcast list message, how many recipients received it (ZCHILDMESSAGESDELIVEREDCOUNT).',
  },
  childMessagesReadCount: {
    ...nullableInteger,
    description:
      'For a broadcast list message, how many recipients read it (ZCHILDMESSAGESREADCOUNT).',
  },
  childMessagesPlayedCount: {
    ...nullableInteger,
    description:
      'For a broadcast list message, how many recipients played it (ZCHILDMESSAGESPLAYEDCOUNT).',
  },
  filteredRecipientCount: {
    ...nullableInteger,
    description:
      'For a broadcast list message, how many recipients WhatsApp did not send it to (ZFILTEREDRECIPIENTCOUNT).',
  },
  parentStanzaId: {
    ...nullableText,
    description:
      'The stanza ID of the message this one belongs to in ChatStorage (ZPARENTMESSAGE); see messageAssociations for albums.',
  },
  quotedStanzaId: {
    ...nullableText,
    description:
      'For a reply, the stanza ID of the message it quotes, in the same chat; decoded from metadata.',
  },
  quotedSenderJid: {
    ...nullableJid,
    description:
      'For a reply, who sent the quoted message, as the reply names them (often a LID where the quoted message holds a phone JID); decoded from metadata.',
  },
  mediaLocalPath: {
    ...nullableText,
    description: media(
      'Where WhatsApp keeps the media file, relative to the Message folder of its container',
      'ZMEDIALOCALPATH',
    ),
  },
  mediaAvailableLocally: {
    ...boolean,
    description:
      'Whether the file at mediaLocalPath was on this Mac when the record was read; most media is never downloaded to it. File bytes are exported only when true.',
  },
  thumbnailLocalPath: {
    ...nullableText,
    description: media(
      'Where WhatsApp keeps the media’s thumbnail, relative to the Message folder',
      'ZTHUMBNAILLOCALPATH',
    ),
  },
  mediaUrl: {
    ...nullableText,
    description: media(
      'The encrypted file on WhatsApp’s servers, or a link message’s URL',
      'ZMEDIAURL',
    ),
  },
  mediaUrlDate: {
    ...nullableInstant,
    description: media('When mediaUrl was issued', 'ZMEDIAURLDATE'),
  },
  fileSize: {
    ...nullableInteger,
    description: media('The media file’s size in bytes', 'ZFILESIZE'),
  },
  movieDuration: {
    ...nullableInteger,
    description: media(
      'A video’s or audio’s length in seconds',
      'ZMOVIEDURATION',
    ),
  },
  aspectRatio: {
    ...nullableNumber,
    description: media('The media’s aspect ratio', 'ZASPECTRATIO'),
  },
  title: {
    ...nullableText,
    description: media(
      'A link’s or document’s title, or an image’s or video’s caption',
      'ZTITLE',
    ),
  },
  authorName: {
    ...nullableText,
    description: media('A document’s file name', 'ZAUTHORNAME'),
  },
  collectionName: {
    ...nullableText,
    description: media('WhatsApp’s collection name', 'ZCOLLECTIONNAME'),
  },
  vCardName: {
    ...nullableText,
    description: media(
      'A contact card’s name; for a media file, the file’s SHA-256 in base64',
      'ZVCARDNAME',
    ),
  },
  vCardString: {
    ...nullableText,
    description: media(
      'A contact card’s vCard; for a media file, its MIME type',
      'ZVCARDSTRING',
    ),
  },
  latitude: {
    ...nullableNumber,
    description: media(
      'A location’s latitude; for an image, video or link preview, its height in pixels',
      'ZLATITUDE',
    ),
  },
  longitude: {
    ...nullableNumber,
    description: media(
      'A location’s longitude; for an image, video or link preview, its width in pixels',
      'ZLONGITUDE',
    ),
  },
  hAccuracy: {
    ...nullableNumber,
    description: media('A location’s accuracy in meters', 'ZHACCURACY'),
  },
  mediaOrigin: {
    ...nullableInteger,
    description: media(
      'WhatsApp’s undocumented media origin code',
      'ZMEDIAORIGIN',
    ),
  },
  cloudStatus: {
    ...nullableInteger,
    description: media(
      'WhatsApp’s undocumented cloud status code',
      'ZCLOUDSTATUS',
    ),
  },
  metadata: {
    ...nullableBase64,
    description:
      'The message’s metadata as WhatsApp stores it (ZWAMEDIAITEM.ZMETADATA), base64: a protobuf with no published schema, holding the reply context, link previews, list menus and a per-message secret.',
  },
  receiptInfo: {
    ...nullableBase64,
    description:
      'The message’s receipts and reactions as WhatsApp stores them (ZWAMESSAGEINFO.ZRECEIPTINFO), base64; messageReceipts and messageReactions decode them.',
  },
} as const;

// A person's JID, not a group's, channel's or broadcast's.
const person = (jid: string | null) =>
  jid !== null && /@(s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;

export class MessagesStream extends WhatsAppMessageStream<
  typeof properties,
  Message
> {
  readonly name = 'messages';
  readonly primaryKey = ['chatJid', 'isFromMe', 'stanzaId'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per WhatsApp message in a chat this Mac holds, with its media item: the file, link preview, contact card or place it carries. Primary key chatJid, isFromMe, stanzaId. WhatsApp writes the store only while it runs, so a message reaches it once WhatsApp has run since. A second copy of a message stands as the first; a message WhatsApp keeps with no chat belongs to no conversation and is not read.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected *messageRows(message: Message): Generator<Message> {
    yield message;
  }

  protected record({
    media: item,
    quoted,
    receiptInfo,
    groupMemberJid,
    fromJid,
    ...message
  }: Message): RecordDraft<typeof properties> {
    return {
      ...message,
      senderJid: message.isFromMe ? null : (groupMemberJid ?? person(fromJid)),
      fromJid,
      groupMemberJid,
      quotedStanzaId: quoted?.stanzaId ?? null,
      quotedSenderJid: quoted?.senderJid ?? null,
      mediaLocalPath: item?.mediaLocalPath ?? null,
      mediaAvailableLocally: (item?.mediaFile ?? null) !== null,
      thumbnailLocalPath: item?.thumbnailLocalPath ?? null,
      mediaUrl: item?.mediaUrl ?? null,
      mediaUrlDate: item?.mediaUrlDate ?? null,
      fileSize: item?.fileSize ?? null,
      movieDuration: item?.movieDuration ?? null,
      aspectRatio: item?.aspectRatio ?? null,
      title: item?.title ?? null,
      authorName: item?.authorName ?? null,
      collectionName: item?.collectionName ?? null,
      vCardName: item?.vCardName ?? null,
      vCardString: item?.vCardString ?? null,
      latitude: item?.latitude ?? null,
      longitude: item?.longitude ?? null,
      hAccuracy: item?.hAccuracy ?? null,
      mediaOrigin: item?.mediaOrigin ?? null,
      cloudStatus: item?.cloudStatus ?? null,
      metadata: base64(item?.metadata ?? null),
      receiptInfo: base64(receiptInfo),
    };
  }

  // The original file, not a staged copy: WhatsApp media reaches gigabytes
  // and readers only read it.
  override file(
    { mediaLocalPath, mediaAvailableLocally }: SchemaRecord<typeof properties>,
    scan: WhatsAppScan,
  ): string | null {
    return mediaAvailableLocally && mediaLocalPath !== null
      ? messageMediaFile(scan.container, mediaLocalPath)
      : null;
  }
}
