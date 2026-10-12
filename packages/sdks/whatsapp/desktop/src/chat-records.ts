import type { QuotedMessage } from './message-metadata.ts';

// Each record carries WhatsApp's own codes as numbers: it publishes none of
// them. Times are UTC to the microsecond.

// A conversation: one person, a group, a community, a channel, a broadcast
// list or a contact's statuses (ZWACHATSESSION, with its ZWAGROUPINFO).
export type Chat = {
  readonly jid: string;
  readonly sessionType: number;
  readonly partnerName: string | null;
  readonly contactIdentifier: string | null;
  readonly contactAbId: number | null;
  readonly archived: boolean | null;
  readonly hidden: boolean | null;
  readonly removed: boolean | null;
  readonly flags: number | null;
  readonly unreadCount: number | null;
  readonly messageCounter: number | null;
  readonly identityVerificationState: number | null;
  readonly identityVerificationEpoch: number | null;
  readonly lastMessageDate: string | null;
  readonly lastMessageText: string | null;
  readonly locationSharingEndDate: string | null;
  readonly savedInput: string | null;
  readonly group: Group | null;
};

export type Group = {
  readonly creationDate: string | null;
  readonly creatorJid: string | null;
  readonly ownerJid: string | null;
  readonly subjectTimestamp: string | null;
  readonly subjectOwnerJid: string | null;
  readonly pictureId: string | null;
  readonly picturePath: string | null;
  readonly sourceJid: string | null;
  readonly state: number | null;
};

// What names a message across WhatsApp: its chat, whether this account sent
// it, and the stanza ID its sender gave it.
export type MessageKey = {
  readonly chatJid: string;
  readonly isFromMe: boolean;
  readonly stanzaId: string;
};

// A message (ZWAMESSAGE) with its media item (ZWAMEDIAITEM), which every
// message has one of, holding its file, link preview, contact card or place
// and its metadata.
export type Message = MessageKey & {
  readonly fromJid: string | null;
  readonly toJid: string | null;
  readonly groupMemberJid: string | null;
  readonly pushName: string | null;
  readonly messageDate: string | null;
  readonly sentDate: string | null;
  readonly messageType: number;
  readonly groupEventType: number | null;
  readonly messageStatus: number | null;
  readonly messageErrorStatus: number | null;
  readonly flags: number | null;
  readonly starred: boolean | null;
  readonly sort: number | null;
  readonly text: string | null;
  readonly childMessagesDeliveredCount: number | null;
  readonly childMessagesReadCount: number | null;
  readonly childMessagesPlayedCount: number | null;
  readonly filteredRecipientCount: number | null;
  readonly parentStanzaId: string | null;
  readonly media: MediaItem | null;
  readonly quoted: QuotedMessage | null;
  // ZWAMESSAGEINFO.ZRECEIPTINFO as stored; ReceiptInfo decodes it.
  readonly receiptInfo: Uint8Array | null;
};

export type MediaItem = {
  readonly mediaLocalPath: string | null;
  // mediaLocalPath on disk, when the file is there.
  readonly mediaFile: string | null;
  readonly thumbnailLocalPath: string | null;
  readonly mediaUrl: string | null;
  readonly mediaUrlDate: string | null;
  readonly fileSize: number | null;
  readonly movieDuration: number | null;
  readonly aspectRatio: number | null;
  readonly title: string | null;
  readonly authorName: string | null;
  readonly collectionName: string | null;
  readonly vCardName: string | null;
  readonly vCardString: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly hAccuracy: number | null;
  readonly mediaOrigin: number | null;
  readonly cloudStatus: number | null;
  readonly metadata: Uint8Array | null;
};

// A link or other item WhatsApp found in a message (ZWAMESSAGEDATAITEM).
export type MessageDataItem = MessageKey & {
  readonly index: number;
  readonly type: number | null;
  readonly date: string | null;
  readonly content1: string | null;
  readonly content2: string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly matchedText: string | null;
  readonly sectionId: string | null;
  readonly senderJid: string | null;
  readonly thumbnailPath: string | null;
  readonly ownsThumbnail: boolean | null;
};

export type GroupMember = {
  readonly groupJid: string;
  readonly memberJid: string;
  readonly contactName: string | null;
  readonly firstName: string | null;
  readonly contactIdentifier: string | null;
  readonly contactAbId: number | null;
  readonly isActive: boolean | null;
  readonly isAdmin: boolean | null;
};

export type GroupMembersChange = {
  readonly groupJid: string;
  readonly changeDate: string;
  readonly changeType: number;
  readonly memberJids: string;
};

export type PushName = {
  readonly jid: string;
  readonly pushName: string | null;
};

export type ProfilePicture = {
  readonly jid: string;
  readonly pictureId: string | null;
  readonly path: string | null;
  // The thumbnail WhatsApp keeps for path, when it is on disk.
  readonly file: string | null;
  readonly requestDate: string | null;
};

export type ChatPushConfig = {
  readonly jid: string;
  readonly alerts: number | null;
  readonly mutedUntil: string | null;
  readonly sound: string | null;
  readonly ringtone: string | null;
};
