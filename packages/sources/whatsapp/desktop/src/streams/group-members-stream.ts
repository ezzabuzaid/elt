import type { RecordDraft } from '@eltjs/elt';
import type { GroupMember } from '@eltjs/sdk-whatsapp-desktop';

import type { WhatsAppScan } from '../whatsapp-scan.ts';
import { WhatsAppStream, rowId, whatsappFields } from '../whatsapp-stream.ts';

const { jid, integer, nullableText, nullableInteger, nullableBoolean } =
  whatsappFields;

const properties = {
  id: rowId('ZWAGROUPMEMBER'),
  chatId: {
    ...integer,
    description: 'The group’s chat; refers to chats.id.',
  },
  groupJid: {
    ...jid,
    description: 'The group’s JID (chats.jid).',
  },
  memberJid: {
    ...jid,
    description:
      'The member, as <LID>@lid, <number>@s.whatsapp.net or a bot’s …@bot (ZMEMBERJID).',
  },
  contactName: {
    ...nullableText,
    description: 'The name WhatsApp shows for the member (ZCONTACTNAME).',
  },
  firstName: {
    ...nullableText,
    description: 'The member’s first name from the address book (ZFIRSTNAME).',
  },
  contactIdentifier: {
    ...nullableText,
    description:
      'The member’s other WhatsApp JID when WhatsApp records it, as for a chat (ZCONTACTIDENTIFIER); NULL in every row on 2026-10-15.',
  },
  contactAbId: {
    ...nullableInteger,
    description: 'The member’s address book record number (ZCONTACTABID).',
  },
  isActive: {
    ...nullableBoolean,
    description: 'Whether the person is still in the group (ZISACTIVE).',
  },
  isAdmin: {
    ...nullableBoolean,
    description: 'Whether the person is a group admin (ZISADMIN).',
  },
} as const;

export class GroupMembersStream extends WhatsAppStream<
  typeof properties,
  GroupMember
> {
  readonly name = 'groupMembers';
  readonly store = 'chatStorage';
  readonly primaryKey = ['id'];
  readonly jsonSchema = {
    type: 'object',
    description:
      'One record per person WhatsApp lists for a group, including those who left (isActive false). Primary key id.',
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(scan: WhatsAppScan): Iterable<GroupMember> {
    return scan.chatStorage.groupMembers;
  }

  protected record(member: GroupMember): RecordDraft<typeof properties> {
    return { ...member };
  }
}
