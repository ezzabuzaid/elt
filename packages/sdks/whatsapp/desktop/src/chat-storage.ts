import { join } from 'node:path';

import { Snapshot, type SnapshotColumns } from '@zukhruf/sqlite-snapshot';

import type {
  Chat,
  ChatPushConfig,
  GroupMember,
  GroupMembersChange,
  MediaItem,
  Message,
  MessageDataItem,
  ProfilePicture,
  PushName,
} from './chat-records.ts';
import { WhatsAppSchemaError, WhatsAppUnavailableError } from './errors.ts';
import { quotedMessage } from './message-metadata.ts';
import {
  bytes,
  flag,
  instant,
  number,
  onDisk,
  requiredFlag,
  requiredNumber,
  requiredText,
  text,
} from './values.ts';

// Every column this reader reads. Columns that only serve WhatsApp itself
// are left out: Spotlight and search indexing, encryption retries and keys,
// participant hashes, sync tags and row references.
const requiredColumns = {
  ZWACHATSESSION: [
    'Z_PK',
    'ZCONTACTJID',
    'ZSESSIONTYPE',
    'ZPARTNERNAME',
    'ZCONTACTIDENTIFIER',
    'ZCONTACTABID',
    'ZARCHIVED',
    'ZHIDDEN',
    'ZREMOVED',
    'ZFLAGS',
    'ZUNREADCOUNT',
    'ZMESSAGECOUNTER',
    'ZIDENTITYVERIFICATIONSTATE',
    'ZIDENTITYVERIFICATIONEPOCH',
    'ZLASTMESSAGEDATE',
    'ZLASTMESSAGETEXT',
    'ZLOCATIONSHARINGENDDATE',
    'ZSAVEDINPUT',
    'ZGROUPINFO',
  ],
  ZWAGROUPINFO: [
    'Z_PK',
    'ZCREATIONDATE',
    'ZCREATORJID',
    'ZOWNERJID',
    'ZSUBJECTTIMESTAMP',
    'ZSUBJECTOWNERJID',
    'ZPICTUREID',
    'ZPICTUREPATH',
    'ZSOURCEJID',
    'ZSTATE',
  ],
  ZWAMESSAGE: [
    'Z_PK',
    'ZCHATSESSION',
    'ZISFROMME',
    'ZSTANZAID',
    'ZFROMJID',
    'ZTOJID',
    'ZGROUPMEMBER',
    'ZPUSHNAME',
    'ZMESSAGEDATE',
    'ZSENTDATE',
    'ZMESSAGETYPE',
    'ZGROUPEVENTTYPE',
    'ZMESSAGESTATUS',
    'ZMESSAGEERRORSTATUS',
    'ZFLAGS',
    'ZSTARRED',
    'ZSORT',
    'ZTEXT',
    'ZCHILDMESSAGESDELIVEREDCOUNT',
    'ZCHILDMESSAGESREADCOUNT',
    'ZCHILDMESSAGESPLAYEDCOUNT',
    'ZFILTEREDRECIPIENTCOUNT',
    'ZPARENTMESSAGE',
    'ZMEDIAITEM',
    'ZMESSAGEINFO',
  ],
  ZWAMEDIAITEM: [
    'Z_PK',
    'ZMEDIALOCALPATH',
    'ZTHUMBNAILLOCALPATH',
    'ZMEDIAURL',
    'ZMEDIAURLDATE',
    'ZFILESIZE',
    'ZMOVIEDURATION',
    'ZASPECTRATIO',
    'ZTITLE',
    'ZAUTHORNAME',
    'ZCOLLECTIONNAME',
    'ZVCARDNAME',
    'ZVCARDSTRING',
    'ZLATITUDE',
    'ZLONGITUDE',
    'ZHACCURACY',
    'ZMEDIAORIGIN',
    'ZCLOUDSTATUS',
    'ZMETADATA',
  ],
  ZWAMESSAGEINFO: ['Z_PK', 'ZRECEIPTINFO'],
  ZWAMESSAGEDATAITEM: [
    'ZMESSAGE',
    'ZINDEX',
    'ZTYPE',
    'ZDATE',
    'ZCONTENT1',
    'ZCONTENT2',
    'ZTITLE',
    'ZSUMMARY',
    'ZMATCHEDTEXT',
    'ZSECTIONID',
    'ZSENDERJID',
    'ZTHUMBNAILPATH',
    'ZOWNSTHUMBNAIL',
  ],
  ZWAGROUPMEMBER: [
    'Z_PK',
    'ZCHATSESSION',
    'ZMEMBERJID',
    'ZCONTACTNAME',
    'ZFIRSTNAME',
    'ZCONTACTIDENTIFIER',
    'ZCONTACTABID',
    'ZISACTIVE',
    'ZISADMIN',
  ],
  ZWAGROUPMEMBERSCHANGE: [
    'Z_PK',
    'ZGROUPJID',
    'ZCHANGEDATE',
    'ZCHANGETYPE',
    'ZMEMBERJIDS',
  ],
  ZWAPROFILEPUSHNAME: ['Z_PK', 'ZJID', 'ZPUSHNAME'],
  ZWAPROFILEPICTUREITEM: [
    'Z_PK',
    'ZJID',
    'ZPICTUREID',
    'ZPATH',
    'ZREQUESTDATE',
  ],
  ZWABLACKLISTITEM: ['Z_PK', 'ZJID'],
  ZWACHATPUSHCONFIG: [
    'Z_PK',
    'ZJID',
    'ZALERTS',
    'ZMUTEDUNTIL',
    'ZSOUND',
    'ZRINGTONE',
  ],
} satisfies SnapshotColumns;

// Where WhatsApp keeps a message's media file, from its mediaLocalPath.
export function messageMediaFile(
  container: string,
  mediaLocalPath: string,
): string {
  return join(container, 'Message', mediaLocalPath);
}

// Where WhatsApp keeps the thumbnail of a profile picture, the only copy it
// stores, from the picture's path.
export function profilePictureFile(container: string, path: string): string {
  return join(container, `${path}.thumb`);
}

// The key columns of a message joined to its chat, which every query on a
// message's children selects the same way.
const messageKey = `chat.ZCONTACTJID AS chatJid, message.ZISFROMME AS isFromMe,
  message.ZSTANZAID AS stanzaId`;

// ChatStorage.sqlite as of one moment, so a message, its chat and its sender
// agree. A message whose chat WhatsApp removed belongs to no conversation it
// shows, and has no key; it is not read. Hold it only while reading: an open
// read stops WhatsApp checkpointing its WAL.
export class ChatStorageSnapshot implements Disposable {
  readonly #database: Snapshot;
  readonly #container: string;

  constructor(path: string, container: string) {
    this.#database = new Snapshot(path, WhatsAppUnavailableError);
    this.#database.requireColumns(requiredColumns, WhatsAppSchemaError);
    this.#container = container;
  }

  chats(): IteratorObject<Chat, undefined> {
    return this.#database
      .iterate(
        `SELECT chat.ZCONTACTJID AS jid, chat.ZSESSIONTYPE AS sessionType,
                chat.ZPARTNERNAME AS partnerName,
                chat.ZCONTACTIDENTIFIER AS contactIdentifier,
                chat.ZCONTACTABID AS contactAbId, chat.ZARCHIVED AS archived,
                chat.ZHIDDEN AS hidden, chat.ZREMOVED AS removed,
                chat.ZFLAGS AS flags, chat.ZUNREADCOUNT AS unreadCount,
                chat.ZMESSAGECOUNTER AS messageCounter,
                chat.ZIDENTITYVERIFICATIONSTATE AS identityVerificationState,
                chat.ZIDENTITYVERIFICATIONEPOCH AS identityVerificationEpoch,
                chat.ZLASTMESSAGEDATE AS lastMessageDate,
                chat.ZLASTMESSAGETEXT AS lastMessageText,
                chat.ZLOCATIONSHARINGENDDATE AS locationSharingEndDate,
                chat.ZSAVEDINPUT AS savedInput, grp.Z_PK AS groupId,
                grp.ZCREATIONDATE AS creationDate,
                grp.ZCREATORJID AS creatorJid, grp.ZOWNERJID AS ownerJid,
                grp.ZSUBJECTTIMESTAMP AS subjectTimestamp,
                grp.ZSUBJECTOWNERJID AS subjectOwnerJid,
                grp.ZPICTUREID AS pictureId, grp.ZPICTUREPATH AS picturePath,
                grp.ZSOURCEJID AS sourceJid, grp.ZSTATE AS state
         FROM ZWACHATSESSION AS chat
         LEFT JOIN ZWAGROUPINFO AS grp ON grp.Z_PK = chat.ZGROUPINFO
         ORDER BY chat.Z_PK`,
      )
      .map((row) => ({
        jid: requiredText(row.jid, 'A WhatsApp chat has no JID'),
        sessionType: requiredNumber(
          row.sessionType,
          'A WhatsApp chat has no session type',
        ),
        partnerName: text(row.partnerName),
        contactIdentifier: text(row.contactIdentifier),
        contactAbId: number(row.contactAbId),
        archived: flag(row.archived),
        hidden: flag(row.hidden),
        removed: flag(row.removed),
        flags: number(row.flags),
        unreadCount: number(row.unreadCount),
        messageCounter: number(row.messageCounter),
        identityVerificationState: number(row.identityVerificationState),
        identityVerificationEpoch: number(row.identityVerificationEpoch),
        lastMessageDate: instant(row.lastMessageDate),
        lastMessageText: text(row.lastMessageText),
        locationSharingEndDate: instant(row.locationSharingEndDate),
        savedInput: text(row.savedInput),
        group:
          row.groupId === null
            ? null
            : {
                creationDate: instant(row.creationDate),
                creatorJid: text(row.creatorJid),
                ownerJid: text(row.ownerJid),
                subjectTimestamp: instant(row.subjectTimestamp),
                subjectOwnerJid: text(row.subjectOwnerJid),
                pictureId: text(row.pictureId),
                picturePath: text(row.picturePath),
                sourceJid: text(row.sourceJid),
                state: number(row.state),
              },
      }));
  }

  // Read as the caller iterates: a store keeps tens of thousands of
  // messages, so no read holds them all.
  messages(): IteratorObject<Message, undefined> {
    return this.#database
      .iterate(
        `SELECT ${messageKey}, message.ZFROMJID AS fromJid,
                message.ZTOJID AS toJid, member.ZMEMBERJID AS groupMemberJid,
                message.ZPUSHNAME AS pushName,
                message.ZMESSAGEDATE AS messageDate,
                message.ZSENTDATE AS sentDate,
                message.ZMESSAGETYPE AS messageType,
                message.ZGROUPEVENTTYPE AS groupEventType,
                message.ZMESSAGESTATUS AS messageStatus,
                message.ZMESSAGEERRORSTATUS AS messageErrorStatus,
                message.ZFLAGS AS flags, message.ZSTARRED AS starred,
                message.ZSORT AS sort, message.ZTEXT AS text,
                message.ZCHILDMESSAGESDELIVEREDCOUNT AS childMessagesDeliveredCount,
                message.ZCHILDMESSAGESREADCOUNT AS childMessagesReadCount,
                message.ZCHILDMESSAGESPLAYEDCOUNT AS childMessagesPlayedCount,
                message.ZFILTEREDRECIPIENTCOUNT AS filteredRecipientCount,
                parent.ZSTANZAID AS parentStanzaId, media.Z_PK AS mediaId,
                media.ZMEDIALOCALPATH AS mediaLocalPath,
                media.ZTHUMBNAILLOCALPATH AS thumbnailLocalPath,
                media.ZMEDIAURL AS mediaUrl,
                media.ZMEDIAURLDATE AS mediaUrlDate,
                media.ZFILESIZE AS fileSize,
                media.ZMOVIEDURATION AS movieDuration,
                media.ZASPECTRATIO AS aspectRatio, media.ZTITLE AS title,
                media.ZAUTHORNAME AS authorName,
                media.ZCOLLECTIONNAME AS collectionName,
                media.ZVCARDNAME AS vCardName,
                media.ZVCARDSTRING AS vCardString,
                media.ZLATITUDE AS latitude, media.ZLONGITUDE AS longitude,
                media.ZHACCURACY AS hAccuracy,
                media.ZMEDIAORIGIN AS mediaOrigin,
                media.ZCLOUDSTATUS AS cloudStatus,
                media.ZMETADATA AS metadata, info.ZRECEIPTINFO AS receiptInfo
         FROM ZWAMESSAGE AS message
         JOIN ZWACHATSESSION AS chat ON chat.Z_PK = message.ZCHATSESSION
         LEFT JOIN ZWAGROUPMEMBER AS member ON member.Z_PK = message.ZGROUPMEMBER
         LEFT JOIN ZWAMESSAGE AS parent ON parent.Z_PK = message.ZPARENTMESSAGE
         LEFT JOIN ZWAMEDIAITEM AS media ON media.Z_PK = message.ZMEDIAITEM
         LEFT JOIN ZWAMESSAGEINFO AS info ON info.Z_PK = message.ZMESSAGEINFO
         ORDER BY message.Z_PK`,
      )
      .map((row) => {
        const metadata = bytes(row.metadata);
        return {
          ...key(row),
          fromJid: text(row.fromJid),
          toJid: text(row.toJid),
          groupMemberJid: text(row.groupMemberJid),
          pushName: text(row.pushName),
          messageDate: instant(row.messageDate),
          sentDate: instant(row.sentDate),
          messageType: requiredNumber(
            row.messageType,
            'A WhatsApp message has no type',
          ),
          groupEventType: number(row.groupEventType),
          messageStatus: number(row.messageStatus),
          messageErrorStatus: number(row.messageErrorStatus),
          flags: number(row.flags),
          starred: flag(row.starred),
          sort: number(row.sort),
          text: text(row.text),
          childMessagesDeliveredCount: number(row.childMessagesDeliveredCount),
          childMessagesReadCount: number(row.childMessagesReadCount),
          childMessagesPlayedCount: number(row.childMessagesPlayedCount),
          filteredRecipientCount: number(row.filteredRecipientCount),
          parentStanzaId: text(row.parentStanzaId),
          media: row.mediaId === null ? null : this.#media(row, metadata),
          quoted: metadata === null ? null : quotedMessage(metadata),
          receiptInfo: bytes(row.receiptInfo),
        };
      });
  }

  dataItems(): IteratorObject<MessageDataItem, undefined> {
    return this.#database
      .iterate(
        `SELECT ${messageKey}, item.ZINDEX AS "index", item.ZTYPE AS type,
                item.ZDATE AS date, item.ZCONTENT1 AS content1,
                item.ZCONTENT2 AS content2, item.ZTITLE AS title,
                item.ZSUMMARY AS summary, item.ZMATCHEDTEXT AS matchedText,
                item.ZSECTIONID AS sectionId, item.ZSENDERJID AS senderJid,
                item.ZTHUMBNAILPATH AS thumbnailPath,
                item.ZOWNSTHUMBNAIL AS ownsThumbnail
         FROM ZWAMESSAGEDATAITEM AS item
         JOIN ZWAMESSAGE AS message ON message.Z_PK = item.ZMESSAGE
         JOIN ZWACHATSESSION AS chat ON chat.Z_PK = message.ZCHATSESSION
         ORDER BY message.Z_PK, item.ZINDEX`,
      )
      .map((row) => ({
        ...key(row),
        index: requiredNumber(row.index, 'A WhatsApp data item has no index'),
        type: number(row.type),
        date: instant(row.date),
        content1: text(row.content1),
        content2: text(row.content2),
        title: text(row.title),
        summary: text(row.summary),
        matchedText: text(row.matchedText),
        sectionId: text(row.sectionId),
        senderJid: text(row.senderJid),
        thumbnailPath: text(row.thumbnailPath),
        ownsThumbnail: flag(row.ownsThumbnail),
      }));
  }

  groupMembers(): IteratorObject<GroupMember, undefined> {
    return this.#database
      .iterate(
        `SELECT chat.ZCONTACTJID AS groupJid, member.ZMEMBERJID AS memberJid,
                member.ZCONTACTNAME AS contactName,
                member.ZFIRSTNAME AS firstName,
                member.ZCONTACTIDENTIFIER AS contactIdentifier,
                member.ZCONTACTABID AS contactAbId,
                member.ZISACTIVE AS isActive, member.ZISADMIN AS isAdmin
         FROM ZWAGROUPMEMBER AS member
         JOIN ZWACHATSESSION AS chat ON chat.Z_PK = member.ZCHATSESSION
         ORDER BY member.Z_PK`,
      )
      .map((row) => ({
        groupJid: requiredText(row.groupJid, 'A WhatsApp group has no JID'),
        memberJid: requiredText(
          row.memberJid,
          'A WhatsApp group member has no JID',
        ),
        contactName: text(row.contactName),
        firstName: text(row.firstName),
        contactIdentifier: text(row.contactIdentifier),
        contactAbId: number(row.contactAbId),
        isActive: flag(row.isActive),
        isAdmin: flag(row.isAdmin),
      }));
  }

  groupMembersChanges(): IteratorObject<GroupMembersChange, undefined> {
    return this.#database
      .iterate(
        `SELECT ZGROUPJID AS groupJid, ZCHANGEDATE AS changeDate,
                ZCHANGETYPE AS changeType, ZMEMBERJIDS AS memberJids
         FROM ZWAGROUPMEMBERSCHANGE ORDER BY Z_PK`,
      )
      .map((row) => {
        const changeDate = instant(row.changeDate);
        if (changeDate === null)
          throw new TypeError('A WhatsApp group change has no date');
        return {
          groupJid: requiredText(row.groupJid, 'A WhatsApp group has no JID'),
          changeDate,
          changeType: requiredNumber(
            row.changeType,
            'A WhatsApp group change has no type',
          ),
          memberJids: requiredText(
            row.memberJids,
            'A WhatsApp group change names no member',
          ),
        };
      });
  }

  pushNames(): IteratorObject<PushName, undefined> {
    return this.#database
      .iterate(
        'SELECT ZJID AS jid, ZPUSHNAME AS pushName FROM ZWAPROFILEPUSHNAME ORDER BY Z_PK',
      )
      .map((row) => ({
        jid: requiredText(row.jid, 'A WhatsApp push name has no JID'),
        pushName: text(row.pushName),
      }));
  }

  profilePictures(): IteratorObject<ProfilePicture, undefined> {
    return this.#database
      .iterate(
        `SELECT ZJID AS jid, ZPICTUREID AS pictureId, ZPATH AS path,
                ZREQUESTDATE AS requestDate
         FROM ZWAPROFILEPICTUREITEM ORDER BY Z_PK`,
      )
      .map((row) => {
        const path = text(row.path);
        return {
          jid: requiredText(row.jid, 'A WhatsApp profile picture has no JID'),
          pictureId: text(row.pictureId),
          path,
          file:
            path === null
              ? null
              : onDisk(profilePictureFile(this.#container, path)),
          requestDate: instant(row.requestDate),
        };
      });
  }

  blockedJids(): IteratorObject<string, undefined> {
    return this.#database
      .iterate('SELECT ZJID AS jid FROM ZWABLACKLISTITEM ORDER BY Z_PK')
      .map((row) =>
        requiredText(row.jid, 'A blocked WhatsApp contact has no JID'),
      );
  }

  chatPushConfigs(): IteratorObject<ChatPushConfig, undefined> {
    return this.#database
      .iterate(
        `SELECT ZJID AS jid, ZALERTS AS alerts, ZMUTEDUNTIL AS mutedUntil,
                ZSOUND AS sound, ZRINGTONE AS ringtone
         FROM ZWACHATPUSHCONFIG ORDER BY Z_PK`,
      )
      .map((row) => ({
        jid: requiredText(row.jid, 'A WhatsApp chat setting has no JID'),
        alerts: number(row.alerts),
        mutedUntil: instant(row.mutedUntil),
        sound: text(row.sound),
        ringtone: text(row.ringtone),
      }));
  }

  [Symbol.dispose](): void {
    this.#database[Symbol.dispose]();
  }

  #media(row: Record<string, unknown>, metadata: Uint8Array | null): MediaItem {
    const mediaLocalPath = text(row.mediaLocalPath);
    return {
      mediaLocalPath,
      mediaFile:
        mediaLocalPath === null
          ? null
          : onDisk(messageMediaFile(this.#container, mediaLocalPath)),
      thumbnailLocalPath: text(row.thumbnailLocalPath),
      mediaUrl: text(row.mediaUrl),
      mediaUrlDate: instant(row.mediaUrlDate),
      fileSize: number(row.fileSize),
      movieDuration: number(row.movieDuration),
      aspectRatio: number(row.aspectRatio),
      title: text(row.title),
      authorName: text(row.authorName),
      collectionName: text(row.collectionName),
      vCardName: text(row.vCardName),
      vCardString: text(row.vCardString),
      latitude: number(row.latitude),
      longitude: number(row.longitude),
      hAccuracy: number(row.hAccuracy),
      mediaOrigin: number(row.mediaOrigin),
      cloudStatus: number(row.cloudStatus),
      metadata,
    };
  }
}

function key(row: Record<string, unknown>) {
  return {
    chatJid: requiredText(row.chatJid, 'A WhatsApp chat has no JID'),
    isFromMe: requiredFlag(
      row.isFromMe,
      'A WhatsApp message has no sender side',
    ),
    stanzaId: requiredText(row.stanzaId, 'A WhatsApp message has no stanza ID'),
  };
}
