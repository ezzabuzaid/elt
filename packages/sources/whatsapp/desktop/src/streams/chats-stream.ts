import type { RecordDraft } from '@workspace/elt';
import type { Chat } from '@workspace/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, whatsappFields } from '../whatsapp-stream.ts';

const {
  jid,
  nullableJid,
  integer,
  nullableInteger,
  nullableText,
  nullableBoolean,
  nullableInstant,
} = whatsappFields;
const groupOnly = 'NULL for a chat that is not a group.';

const properties = {
  jid: {
    ...jid,
    description:
      'The chat’s JID (ZWACHATSESSION.ZCONTACTJID): a person as <number>@s.whatsapp.net or <LID>@lid, a group as …@g.us, a channel as …@newsletter, a broadcast list as …@broadcast, a contact’s statuses as …@lid.status. The primary key.',
  },
  sessionType: {
    ...integer,
    description:
      'WhatsApp’s chat kind (ZSESSIONTYPE), seen as: 0 one person, 1 group, 2 broadcast list, 3 statuses, 4 a group kept apart from type 1, 5 channel. WhatsApp documents none of them.',
  },
  partnerName: {
    ...nullableText,
    description:
      'The name WhatsApp shows for the chat: the group subject, or the person’s name (ZPARTNERNAME).',
  },
  contactIdentifier: {
    ...nullableText,
    description:
      'The person’s other WhatsApp JID (ZCONTACTIDENTIFIER): a chat keyed by phone number holds the person’s LID (<id>@lid), and a chat keyed by LID holds their phone JID (<phoneNumber>@s.whatsapp.net). NULL when WhatsApp has not linked the two.',
  },
  contactAbId: {
    ...nullableInteger,
    description: 'The address book record number of the person (ZCONTACTABID).',
  },
  archived: {
    ...nullableBoolean,
    description: 'Whether the chat is archived (ZARCHIVED).',
  },
  hidden: {
    ...nullableBoolean,
    description: 'Whether WhatsApp hides the chat from its list (ZHIDDEN).',
  },
  removed: {
    ...nullableBoolean,
    description: 'Whether the chat was removed from the list (ZREMOVED).',
  },
  flags: {
    ...nullableInteger,
    description: 'WhatsApp’s undocumented bit flags of the chat (ZFLAGS).',
  },
  unreadCount: {
    ...nullableInteger,
    description: 'Unread messages, as the badge shows them (ZUNREADCOUNT).',
  },
  messageCounter: {
    ...nullableInteger,
    description:
      'WhatsApp’s running message count of the chat (ZMESSAGECOUNTER).',
  },
  identityVerificationState: {
    ...nullableInteger,
    description:
      'WhatsApp’s code for whether the person’s security code was verified (ZIDENTITYVERIFICATIONSTATE).',
  },
  identityVerificationEpoch: {
    ...nullableInteger,
    description:
      'Which of the person’s identity keys the verification state is for (ZIDENTITYVERIFICATIONEPOCH).',
  },
  lastMessageDate: {
    ...nullableInstant,
    description:
      'When the chat’s last message was sent, UTC (ZLASTMESSAGEDATE).',
  },
  lastMessageText: {
    ...nullableText,
    description:
      'Despite its name, WhatsApp’s state of the chat as it stores it (ZLASTMESSAGETEXT): a protobuf in base64 holding, among others, the last message’s stanza ID (field 13) and pinned messages with their pin’s expiry (fields 31 and 34).',
  },
  locationSharingEndDate: {
    ...nullableInstant,
    description:
      'When the account’s live location sharing in the chat ends (ZLOCATIONSHARINGENDDATE).',
  },
  savedInput: {
    ...nullableText,
    description: 'An unsent draft typed into the chat (ZSAVEDINPUT).',
  },
  groupCreationDate: {
    ...nullableInstant,
    description: `When the group was created (ZWAGROUPINFO.ZCREATIONDATE); ${groupOnly}`,
  },
  groupCreatorJid: {
    ...nullableJid,
    description: `Who created the group (ZCREATORJID); ${groupOnly}`,
  },
  groupOwnerJid: {
    ...nullableJid,
    description: `The group’s owner (ZOWNERJID); ${groupOnly}`,
  },
  groupSubjectTimestamp: {
    ...nullableInstant,
    description: `When the group subject was last set (ZSUBJECTTIMESTAMP); ${groupOnly}`,
  },
  groupSubjectOwnerJid: {
    ...nullableJid,
    description: `Who last set the group subject (ZSUBJECTOWNERJID); ${groupOnly}`,
  },
  groupPictureId: {
    ...nullableText,
    description: `The group picture’s ID (ZPICTUREID); ${groupOnly}`,
  },
  groupPicturePath: {
    ...nullableText,
    description: `Where WhatsApp keeps the group picture, relative to its container (ZPICTUREPATH); ${groupOnly}`,
  },
  groupSourceJid: {
    ...nullableJid,
    description: `The group this one came from, such as a community’s (ZSOURCEJID); ${groupOnly}`,
  },
  groupState: {
    ...nullableInteger,
    description: `WhatsApp’s undocumented code for the account’s state in the group (ZSTATE); ${groupOnly}`,
  },
} as const;

export class ChatsStream extends WhatsAppStream<typeof properties, Chat> {
  readonly name = 'chats';
  readonly store = 'chatStorage';
  readonly primaryKey = ['jid'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per WhatsApp chat: a person, a group, a channel, a broadcast list or a contact’s statuses, with the group’s details for a group. Primary key jid. WhatsApp keeps a second, empty session for a few JIDs; the first stands for both.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): readonly Chat[] {
    return scan.chatStorage.chats;
  }

  protected record({ group, ...chat }: Chat): RecordDraft<typeof properties> {
    return {
      ...chat,
      groupCreationDate: group?.creationDate ?? null,
      groupCreatorJid: group?.creatorJid ?? null,
      groupOwnerJid: group?.ownerJid ?? null,
      groupSubjectTimestamp: group?.subjectTimestamp ?? null,
      groupSubjectOwnerJid: group?.subjectOwnerJid ?? null,
      groupPictureId: group?.pictureId ?? null,
      groupPicturePath: group?.picturePath ?? null,
      groupSourceJid: group?.sourceJid ?? null,
      groupState: group?.state ?? null,
    };
  }
}
